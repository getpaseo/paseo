import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { profiles } from "../shared/profiles";
import { prepareAgent, runtime } from "./runtime";
import * as executionRouting from "./execution-routing";
import { workflowSettings } from "./state";
import type { WorkflowPort } from "./workflow";

let directory: string;
let base: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "workflow-turn-proof-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Workflow Test");
  git("config", "user.email", "workflow@example.invalid");
  await writeFile(path.join(directory, "feature.txt"), "base\n");
  git("add", "feature.txt");
  git("commit", "--quiet", "-m", "base");
  base = git("rev-parse", "HEAD");
  await writeFile(path.join(directory, "feature.txt"), "changed\n");
  git("commit", "--quiet", "-am", "change");
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each(["router", "planner", "plan-reviewer", "audit-deep", "final-review"])(
  "handoff executor preserves selected %s profile config without source-role preparation",
  async (role) => {
    const request: Parameters<typeof prepareAgent>[0] = {
      workspaceId: "workspace",
      launchProfileId: `paseo-workflow-${role}`,
      labels: { "paseo.workflow.role": "executor" },
      config: {
        provider: "codex",
        cwd: "/workspace",
        modeId: "default",
        featureValues: { plan_mode: true },
        writePolicy: "read_write",
      },
    };
    const api = { config: { get: async () => ({ config: { agentProfiles: profiles } }) } };
    const result = await prepareAgent(request, api as Parameters<typeof prepareAgent>[1]);
    expect(result).toEqual(
      ["router", "plan-reviewer", "audit-deep"].includes(role)
        ? { ...request, config: { ...request.config, writePolicy: "read_only" } }
        : request,
    );
  },
);

test("handoff cannot launch a deleted workflow profile", async () => {
  const request: Parameters<typeof prepareAgent>[0] = {
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-audit-deep",
    labels: { "paseo.workflow.role": "executor" },
    config: { provider: "codex", cwd: "/workspace" },
  };
  const api = { config: { get: async () => ({ config: { agentProfiles: [] } }) } };
  await expect(prepareAgent(request, api as Parameters<typeof prepareAgent>[1])).rejects.toThrow(
    "is missing",
  );
});

test.each([true, false])(
  "initial routing passes plan_mode=%s and preserves the session mode",
  async (planMode) => {
    const decision = {
      category: "bounded" as const,
      provider: "codex" as const,
      model: "gpt-5.6-sol",
      effort: "medium" as const,
      reason: "Test decision",
    };
    const classify = vi
      .spyOn(executionRouting, "classifyInitialExecution")
      .mockResolvedValue(decision);
    try {
      const request: Parameters<typeof prepareAgent>[0] = {
        workspaceId: "workspace",
        config: {
          provider: "codex",
          cwd: directory,
          modeId: "default",
          featureValues: { plan_mode: planMode, fast_mode: true },
        },
        modelRouting: { strategy: "jev", prompt: "Ajouter Auto" },
      };
      const api = {
        workspaces: { ref: () => ({ refresh: async () => ({ intent: "Mobile app" }) }) },
        providers: {
          listModels: async () => ({
            models: [{ id: decision.model, thinkingOptions: [{ id: decision.effort }] }],
          }),
        },
      };
      const signal = new AbortController().signal;
      const result = await prepareAgent(
        request,
        api as unknown as Parameters<typeof prepareAgent>[1],
        signal,
      );
      expect(classify).toHaveBeenCalledExactlyOnceWith(
        {
          prompt: "Ajouter Auto",
          modeId: "default",
          featureValues: request.config.featureValues,
          workspaceIntent: "Mobile app",
        },
        signal,
      );
      expect(result.config).toEqual({
        ...request.config,
        model: decision.model,
        thinkingOptionId: decision.effort,
      });
      expect(result.modelRouting).toEqual({ ...request.modelRouting, resolved: true });
    } finally {
      classify.mockRestore();
    }
  },
);

test("planner approval preserves the plan's authority and permits completion without a commit", async () => {
  const api = {
    config: { get: async () => ({ config: { agentProfiles: profiles } }) },
    workspaces: { ref: () => ({ refresh: async () => ({ intent: "Keep control" }) }) },
  };
  const result = await prepareAgent(
    {
      workspaceId: "workspace",
      launchProfileId: "paseo-workflow-planner",
      config: { provider: "codex", cwd: directory, systemPrompt: "No commit." },
    },
    api as unknown as Parameters<typeof prepareAgent>[1],
  );
  expect(result.config.systemPrompt).toContain("No commit.");
  expect(result.config.systemPrompt).toContain("does not expand authorization");
  expect(result.config.systemPrompt).toContain("only when explicitly authorized");
  expect(result.config.systemPrompt).toContain(
    "A validated local result without a commit is valid",
  );
  expect(result.config.systemPrompt).not.toContain(
    "create a functional commit after successful validation",
  );
});

function row(seq: number, item: AgentTimelineItem, turnId = "turn") {
  return {
    provider: "claude",
    item,
    turnId,
    timestamp: "2026-09-13T00:00:00Z",
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
  };
}

test("handoff discovers execution settings for the selected provider and workspace", async () => {
  const profile = {
    id: "custom",
    name: "Custom",
    provider: "custom-acp",
    model: "chosen",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { other: true },
  };
  const modes = [
    { id: "plan", label: "Plan" },
    { id: "execute", label: "Execute" },
  ];
  const features = [{ type: "toggle" as const, id: "other", label: "Other", value: true }];
  const requests: unknown[] = [];
  const api = {
    providers: {
      waitForReady: async (options: unknown) => {
        requests.push(options);
        return {
          entries: [{ provider: "custom-acp", status: "ready", modes, defaultModeId: "execute" }],
        };
      },
      listFeatures: async (config: unknown) => {
        requests.push(config);
        return { features };
      },
    },
  };
  const controller = runtime(
    api as unknown as Parameters<typeof runtime>[0],
    {} as Parameters<typeof runtime>[1],
  );
  const { port } = controller as unknown as { port: WorkflowPort };
  expect(await port.executionSettings(profile, "/workspace")).toEqual({
    modes,
    features,
    defaultModeId: "execute",
  });
  expect(requests).toEqual([
    { cwd: "/workspace" },
    {
      provider: "custom-acp/chosen",
      cwd: "/workspace",
      modeId: "plan",
      thinkingOptionId: "high",
      featureValues: { other: true },
    },
  ]);
});

test("transcript history requests projected pages while timeline and turn default to canonical", async () => {
  const prompt = row(1, { type: "user_message", text: "Implement" });
  const answer = row(2, { type: "assistant_message", text: "Complete answer" });
  const refetch = vi.fn(async ({ cursor }: { cursor?: string }) =>
    cursor
      ? { entries: [prompt], hasOlder: false }
      : { entries: [answer], hasOlder: true, startCursor: "older-page" },
  );
  const api = { agents: { ref: () => ({ timeline: { refetch } }) } };
  const controller = runtime(
    api as unknown as Parameters<typeof runtime>[0],
    {} as Parameters<typeof runtime>[1],
  );
  const { port } = controller as unknown as { port: WorkflowPort };

  expect(await port.timeline("planner", "projected")).toEqual([prompt.item, answer.item]);
  expect(refetch.mock.calls.map(([request]) => request)).toEqual([
    { limit: 200, projection: "projected" },
    { direction: "before", cursor: "older-page", limit: 200, projection: "projected" },
  ]);
  refetch.mockClear();

  expect(await port.timeline("planner")).toEqual([prompt.item, answer.item]);
  expect(await port.turn("planner", "turn")).toEqual({ key: "turn:2", items: [answer.item] });
  expect(refetch.mock.calls.map(([request]) => request)).toEqual([
    { limit: 200, projection: "canonical" },
    { direction: "before", cursor: "older-page", limit: 200, projection: "canonical" },
    { limit: 200, projection: "canonical" },
    { direction: "before", cursor: "older-page", limit: 200, projection: "canonical" },
  ]);
});

test.each([
  ["assistant", true],
  ["tool", true],
  ["absent", false],
  ["denied", false],
  ["wrong-call", false],
  ["legacy", false],
  ["equal-seq", false],
  ["wrong-turn", false],
  ["no-output", false],
  ["blank-output", false],
  ["plan-only", false],
  ["running-tool", false],
  ["synthetic-pending", false],
  ["synthetic-unknown", false],
] as const)("canonical same-turn execution proof: %s", async (proof, accepted) => {
  const plan: AgentTimelineItem = {
    type: "tool_call",
    callId: proof === "wrong-call" ? "other-plan" : "plan",
    name: "ExitPlanMode",
    detail: { type: "plan", text: "Plan" },
    status: "completed",
    error: null,
    metadata:
      proof === "legacy"
        ? {}
        : {
            approved: proof !== "denied",
            ...(proof.startsWith("synthetic-")
              ? {
                  syntheticPermissionId: "permission",
                  approvalOutcome: proof === "synthetic-pending" ? "pending" : "outcome_unknown",
                }
              : {}),
          },
  };
  let output: AgentTimelineItem = {
    type: "assistant_message",
    text: proof === "blank-output" ? " \n" : "Implemented",
  };
  if (proof === "tool" || proof === "running-tool") {
    output = {
      type: "tool_call",
      callId: "execute",
      name: "shell",
      detail: { type: "shell", command: "git commit -m change", exitCode: 0 },
      status: proof === "running-tool" ? "running" : "completed",
      error: null,
    };
  } else if (proof === "plan-only") output = plan;
  const entries = [
    row(1, { type: "user_message", text: "Plan and implement after approval" }),
    ...(proof === "absent" ? [] : [row(2, plan, proof === "wrong-turn" ? "other-turn" : "turn")]),
    ...(proof === "no-output" ? [] : [row(proof === "equal-seq" ? 2 : 3, output)]),
  ];
  let state = workflowSettings.schema.parse({
    workflows: {
      planner: {
        id: "planner",
        plannerId: "planner",
        workspaceId: "workspace",
        activePlanId: "plan",
        intent: "Keep control",
        request: "Implement",
        constraints: [],
        assumptions: [],
        git: { startHead: base, targetBase: base, branch: "test", dirty: "" },
        recommendation: null,
        plans: {
          plan: {
            approved: true,
            context: {
              workspaceId: "workspace",
              agentId: "planner",
              permissionRequestId: "permission",
              callId: "plan",
              text: "Plan",
            },
          },
        },
      },
    },
  });
  const prompts: string[] = [];
  const api = {
    config: { get: async () => ({ config: { agentProfiles: profiles } }) },
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: {
            workspaceId: "workspace",
            labels: {},
            pendingPermissions: [],
            launchProfileId: `paseo-workflow-${id === "planner" ? "planner" : "final-review"}`,
            status: id === "planner" ? "idle" : "running",
            lastCompletedTurnId: "turn",
          },
        }),
        timeline: { refetch: async () => ({ entries, hasOlder: false }) },
        send: async (text: string) => {
          prompts.push(text);
        },
      }),
    },
    workspaces: {
      ref: () => ({
        refresh: async () => ({ workspaceDirectory: directory, intent: "Keep control" }),
        agents: { create: async () => ({ id: "final-manager" }) },
      }),
    },
  };
  const settings = {
    read: async () => ({ status: "ready", revision: "1", values: structuredClone(state) }),
    write: async (value: unknown) => {
      state = workflowSettings.schema.parse(value);
    },
  };
  const createRuntime = () =>
    runtime(
      api as unknown as Parameters<typeof runtime>[0],
      settings as unknown as Parameters<typeof runtime>[1],
    );
  await createRuntime().status("planner", "workspace");
  await createRuntime().status("planner", "workspace");
  expect(state.workflows.planner!.plans.plan!.final?.phase).toBe(
    accepted ? "classifying" : undefined,
  );
  expect(prompts).toHaveLength(accepted ? 1 : 0);
});

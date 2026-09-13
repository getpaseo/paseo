import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { profiles } from "../shared/profiles";
import { runtime } from "./runtime";
import { workflowSettings } from "./state";

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
] as const)("canonical same-turn execution proof: %s", async (proof, accepted) => {
  const plan: AgentTimelineItem = {
    type: "tool_call",
    callId: proof === "wrong-call" ? "other-plan" : "plan",
    name: "ExitPlanMode",
    detail: { type: "plan", text: "Plan" },
    status: "completed",
    error: null,
    metadata: proof === "legacy" ? {} : { approved: proof !== "denied" },
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
        git: { base, branch: "test", dirty: "" },
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
    read: async () => ({ revision: "1", values: structuredClone(state) }),
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

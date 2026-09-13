import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { settingsRpc } from "@getpaseo/plugin";
import { expect, test } from "vitest";
import { profiles } from "../../../../../plugins/paseo-workflow/shared/profiles.js";
import { workflowSettings } from "../../../../../plugins/paseo-workflow/server/state.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type {
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { AgentTurnNotAcceptedError } from "../agent/agent-sdk-types.js";

async function lifecycleFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-lifecycle-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "workflow@example.invalid");
  git("config", "user.name", "Workflow Test");
  await writeFile(path.join(directory, "feature.txt"), "initial\n");
  git("add", "feature.txt");
  git("commit", "--quiet", "-m", "base");
  const provider = createTestAgentClient("codex");
  const originalCreate = provider.createSession.bind(provider);
  const originalResume = provider.resumeSession.bind(provider);
  const prompts: Array<{ role: string; text: string }> = [];
  const replies = new Map<string, string[]>();
  const holds = new Map<string, Promise<void>>();
  const failures = new Map<string, number>();
  const permissionFailures = new Map<string, number>();
  const sendFailures = new Map<string, "not-accepted" | "unknown">();
  const canceled = new Set<string>();
  const effects = new Map<string, (text: string) => Promise<void>>();
  const toolEvidence = new Map<string, string>();
  const reusedTurnIds = new Set<string>();
  const roleFor = (config: Partial<AgentSessionConfig>) =>
    /Your workflow role is ([\w-]+)/.exec(config.systemPrompt ?? "")?.[1] ?? "router";
  const wrapSession = (
    session: AgentSession,
    config: Partial<AgentSessionConfig>,
    owner: string | undefined,
    resumed = false,
  ) => {
    const role = roleFor(config);
    const describe = session.describePersistence.bind(session);
    session.describePersistence = () => {
      const handle = describe();
      // Mirror Codex's persisted policy/owner contract; the generic fake omits it.
      return handle
        ? {
            ...handle,
            metadata: { ...handle.metadata, writePolicy: config.writePolicy, agentId: owner },
          }
        : null;
    };
    const mapTurnId = (id: string) => {
      if (!reusedTurnIds.has(role) || resumed) return id;
      return role === "final-review" ? "fake-turn-1" : "fake-turn-0";
    };
    const respond = session.respondToPermission.bind(session);
    session.respondToPermission = async (...args) => {
      if (permissionFailures.get(role)) {
        permissionFailures.set(role, permissionFailures.get(role)! - 1);
        throw new Error("Requested deny failure");
      }
      return respond(...args);
    };
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (subscriber) =>
      subscribe((event) => {
        if ("turnId" in event && event.turnId)
          event = { ...event, turnId: mapTurnId(event.turnId) };
        if (event.type === "turn_started" && toolEvidence.has(role)) {
          const command = toolEvidence.get(role)!;
          toolEvidence.delete(role);
          subscriber({
            type: "timeline",
            provider: "codex",
            turnId: event.turnId,
            item: {
              type: "tool_call",
              callId: "old-validation",
              name: "shell",
              status: "completed",
              error: null,
              detail: { type: "shell", command, exitCode: 0 },
            },
          });
        }
        const result =
          event.type === "turn_completed" && canceled.has(role)
            ? {
                type: "turn_canceled" as const,
                provider: "codex",
                turnId: event.turnId,
                reason: "Canceled in provider",
              }
            : event;
        const held = holds.get(role);
        if (held) void held.then(() => subscriber(result));
        else subscriber(result);
      });
    const start = session.startTurn.bind(session);
    session.startTurn = async (input) => {
      const text = typeof input === "string" ? input : JSON.stringify(input);
      const failure = sendFailures.get(role);
      sendFailures.delete(role);
      if (failure === "not-accepted")
        throw new AgentTurnNotAcceptedError("Requested prompt rejection before acceptance");
      prompts.push({ role, text });
      await effects.get(role)?.(text);
      const result = await start(
        `Respond with exactly: ${replies.get(role)?.shift() ?? "Which constraint matters?"}`,
      );
      if (failure === "unknown") throw new Error("Acknowledgement lost after provider acceptance");
      return { turnId: mapTurnId(result.turnId) };
    };
    return session;
  };
  provider.createSession = async (config, context) => {
    const role = roleFor(config);
    if (failures.get(role)) {
      failures.set(role, failures.get(role)! - 1);
      throw new Error("Requested spawn failure");
    }
    return wrapSession(await originalCreate(config, context), config, context?.agentId);
  };
  provider.resumeSession = async (handle, config, context) =>
    wrapSession(
      await originalResume(handle, config, context),
      config ?? {},
      context?.agentId,
      true,
    );
  const daemon = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.patchDaemonConfig({
    pluginsEnabled: true,
    agentProfiles: profiles.map((profile) => Object.assign({}, profile, { modeId: "full-access" })),
  });
  await client.installDirectoryPlugin(path.resolve("plugins/paseo-workflow"));
  const workspace = (
    await client.createWorkspace({ source: { kind: "directory", path: directory } })
  ).workspace!;
  const rpc = settingsRpc("workflows");
  const read = async () => {
    const response = rpc.read.output.parse(
      await client.invokePluginRpc("paseo-workflow", rpc.read.name, {}),
    );
    return { ...response, values: workflowSettings.schema.parse(response.values) };
  };
  const agents = (role: string) =>
    daemon.daemon.agentManager
      .listAgents()
      .filter((agent) => agent.launchProfileId === `paseo-workflow-${role}`);
  return {
    directory,
    git,
    daemon,
    client,
    workspace,
    read,
    agents,
    prompts,
    replies,
    holds,
    failures,
    permissionFailures,
    sendFailures,
    canceled,
    effects,
    toolEvidence,
    reusedTurnIds,
    write: async (values: ReturnType<typeof workflowSettings.schema.parse>) => {
      const state = await read();
      await client.invokePluginRpc("paseo-workflow", rpc.write.name, {
        revision: state.revision,
        values,
      });
    },
    close: async () => {
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function pendingPlan(
  f: Awaited<ReturnType<typeof lifecycleFixture>>,
  plannerId?: string,
  callId = "plan-1",
) {
  const manager = f.daemon.daemon.agentManager;
  const planner = plannerId
    ? manager.getAgent(plannerId)!
    : await f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId: "paseo-workflow-planner",
        modeId: "full-access",
      });
  if (!plannerId) {
    await f.client.sendMessage(planner.id, "Build the requested feature");
    await expect.poll(() => manager.getAgent(planner.id)?.lifecycle).toBe("idle");
  }
  const context = {
    workspaceId: f.workspace.id,
    agentId: planner.id,
    permissionRequestId: `permission-${callId}`,
    callId,
    text: `Exact ${callId}`,
  };
  manager.getAgent(planner.id)!.pendingPermissions.set(context.permissionRequestId, {
    id: context.permissionRequestId,
    provider: "codex",
    name: "Plan",
    kind: "plan",
    sourcePlanCallId: callId,
    input: { plan: context.text },
  });
  return context;
}

test.each([false, true])(
  "real manager lifecycle separates classification, correction decision and validation evidence turns (reused turnId: %s)",
  async (reuse) => {
    const f = await lifecycleFixture();
    try {
      if (reuse) f.reusedTurnIds.add("final-review");
      f.effects.set("audit-economic", async () => {
        if (reuse) await f.daemon.daemon.agentManager.closeAgent(f.agents("final-review")[0]!.id);
      });
      f.replies.set("final-review", [
        '{"classification":"SIMPLE"}',
        '{"correct":true,"validationCommands":["npm run targeted"]}',
        "Correction done without observable checks",
      ]);
      f.toolEvidence.set("final-review", "npm run targeted");
      f.effects.set("final-review", async (text) => {
        if (text.startsWith("Correct only"))
          await writeFile(path.join(f.directory, "feature.txt"), "corrected\n");
      });
      f.replies.set("audit-economic", [
        JSON.stringify({
          findings: [
            {
              summary: "Local defect",
              files: ["feature.txt"],
              certain: true,
              local: true,
              verifiable: true,
              externalEffects: false,
            },
          ],
        }),
      ]);
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      const state = (await f.read()).values;
      state.workflows[plan.agentId]!.activePlanId = plan.callId;
      state.workflows[plan.agentId]!.plans[plan.callId]!.approved = true;
      await f.write(state);
      f.daemon.daemon.agentManager.getAgent(plan.agentId)!.pendingPermissions.clear();
      await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
      f.git("add", "feature.txt");
      f.git("commit", "--quiet", "-m", "functional");
      await f.client.sendMessage(plan.agentId, "Implementation committed");
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
          { timeout: 10_000 },
        )
        .toBe("verification_required");
      expect(f.prompts.filter((prompt) => prompt.role === "final-review")).toHaveLength(3);
      expect(f.agents("audit-economic")).toHaveLength(1);
      const history = await f.daemon.daemon.agentManager.getTimelineRows(
        f.agents("final-review")[0]!.id,
      );
      const evidence = history.find((row) => row.item.type === "tool_call")!;
      const lastPrompt = history.findLast((row) => row.item.type === "user_message")!;
      expect(history.indexOf(evidence)).toBeLessThan(history.indexOf(lastPrompt));
      expect(evidence.turnId === history.at(-1)?.turnId).toBe(reuse);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("consumed approval with rejected ACK reaches the workflow hook once and survives reload", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    const manager = f.daemon.daemon.agentManager;
    await manager.setAgentMode(plan.agentId, "plan");
    const session = manager.getAgent(plan.agentId)!.session!;
    const respond = session.respondToPermission.bind(session);
    // The deterministic provider exposes its notifier privately; keep the real manager queue/hooks.
    const emit = (
      session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
    ).notifySubscribers.bind(session);
    session.respondToPermission = async (...args) => {
      await respond(...args);
      emit({
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Resumed" },
      });
      emit({
        type: "permission_resolved",
        provider: "codex",
        requestId: plan.permissionRequestId,
        resolution: { behavior: "allow" },
      });
      throw new Error("Provider approval ACK lost after consumption");
    };
    const resolutions: string[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_resolved")
          resolutions.push(event.event.requestId);
      },
      { agentId: plan.agentId, replayState: false },
    );
    await expect(
      manager.respondToPermission(plan.agentId, plan.permissionRequestId, { behavior: "allow" }),
    ).rejects.toThrow("ACK lost");
    await expect
      .poll(
        async () => (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved,
      )
      .toBe(true);
    await f.client.reloadPlugin("paseo-workflow");
    const state = (await f.read()).values.workflows[plan.agentId]!;
    expect(state.plans[plan.callId]?.approved).toBe(true);
    expect(state.activePlanId).toBe(plan.callId);
    expect(resolutions).toEqual([plan.permissionRequestId]);
    expect(await session.getCurrentMode()).toBe("auto");
    expect(manager.getAgent(plan.agentId)!.pendingPermissions.has(plan.permissionRequestId)).toBe(
      false,
    );
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["reversed", "normal", "reload"] as const)(
  "approved planner completion starts one final review (%s order)",
  async (order) => {
    const f = await lifecycleFixture();
    let release!: () => void;
    f.holds.set(
      "final-review",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.canceled.add("final-review");
    try {
      const plan = await pendingPlan(f);
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      const manager = f.daemon.daemon.agentManager;
      const session = manager.getAgent(plan.agentId)!.session!;
      const respond = session.respondToPermission.bind(session);
      const emit = (
        session as unknown as { notifySubscribers(event: AgentStreamEvent): void }
      ).notifySubscribers.bind(session);
      const turnId = "approved-implementation";
      const resolution: AgentStreamEvent = {
        type: "permission_resolved",
        provider: "codex",
        requestId: plan.permissionRequestId,
        resolution: { behavior: "allow" },
        turnId,
      };
      const completed: AgentStreamEvent = { type: "turn_completed", provider: "codex", turnId };
      const finish = () => {
        emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: { type: "assistant_message", text: "Functional change committed" },
        });
        emit(completed);
      };
      session.respondToPermission = async (...args) => {
        await respond(...args);
        await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
        f.git("add", "feature.txt");
        f.git("commit", "--quiet", "-m", "functional");
        emit({ type: "turn_started", provider: "codex", turnId });
        emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: {
            type: "user_message",
            text: "Implement the approved plan",
            clientMessageId: "approved-prompt",
          },
        });
        emit(resolution);
        if (order === "reversed") {
          finish();
          throw new Error("Approval ACK rejected after completion");
        }
      };
      const delivered: string[] = [];
      manager.subscribe(
        (event) => {
          if (
            event.type === "agent_stream" &&
            ["permission_resolved", "turn_completed"].includes(event.event.type)
          )
            delivered.push(event.event.type);
        },
        { agentId: plan.agentId, replayState: false },
      );
      const approval = manager.respondToPermission(plan.agentId, plan.permissionRequestId, {
        behavior: "allow",
      });
      if (order === "reversed") await expect(approval).rejects.toThrow("ACK rejected");
      else await approval;
      await expect
        .poll(
          async () => (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.approved,
        )
        .toBe(true);
      if (order === "reload") await f.client.disablePlugin("paseo-workflow");
      if (order !== "reversed") finish();
      await manager.flush();
      expect(delivered).toEqual(
        order === "reversed"
          ? ["turn_completed", "permission_resolved"]
          : ["permission_resolved", "turn_completed"],
      );
      const status = () =>
        f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
          agentId: plan.agentId,
          workspaceId: plan.workspaceId,
        });
      if (order === "reload") {
        await f.client.enablePlugin("paseo-workflow");
        await f.client.reloadPlugin("paseo-workflow");
        await status();
      }
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
        )
        .toBe("classifying");
      const finalId = f.agents("final-review")[0]!.id;
      emit(resolution);
      emit(completed);
      await manager.flush();
      await f.client.reloadPlugin("paseo-workflow");
      await status();
      await status();
      expect(f.agents("final-review").map((agent) => agent.id)).toEqual([finalId]);
      expect(f.prompts.filter((prompt) => prompt.role === "final-review")).toHaveLength(1);
      expect(
        (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
      ).toBe("classifying");
    } finally {
      release();
      await f.close();
    }
  },
  60_000,
);

test("review finishing during failed permission close is consumed once after retry and reload", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    const plan = await pendingPlan(f);
    f.replies.set("plan-reviewer", ["Preserve the existing CSV export"]);
    f.permissionFailures.set("planner", 1);
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("deny failure");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    expect(f.agents("plan-reviewer")).toHaveLength(1);
    const childId = f.agents("plan-reviewer")[0]!.id;
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    release();
    await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
    await f.daemon.daemon.agentManager.flush();
    const status = () =>
      f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
    await status();
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "closing",
    );
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await status();
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "complete",
    );
    await f.client.reloadPlugin("paseo-workflow");
    await status();
    expect(f.agents("plan-reviewer").map((agent) => agent.id)).toEqual([childId]);
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    const revisions = f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.text).toContain("Preserve the existing CSV export");
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test("review send rejection keeps the live plan retryable and delivers once to the same child", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    f.sendFailures.set("plan-reviewer", "not-accepted");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("prompt rejection");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    const childId = f.agents("plan-reviewer")[0]!.id;
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(0);
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    expect(f.agents("plan-reviewer").map((agent) => agent.id)).toEqual([childId]);
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(false);
  } finally {
    await f.close();
  }
}, 60_000);

test("unknown reviewer delivery leaves the plan pending without replay after plugin reload", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    f.sendFailures.set("plan-reviewer", "unknown");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("outcome_unknown");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "outcome_unknown",
    );
    await f.client.reloadPlugin("paseo-workflow");
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("outcome_unknown");
    expect(f.prompts.filter((prompt) => prompt.role === "plan-reviewer")).toHaveLength(1);
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
    expect(f.agents("plan-reviewer")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("Planner clarification after routing is transported in review, handoff and final manager prompts", async () => {
  const f = await lifecycleFixture();
  try {
    f.replies.set("router", [
      '{"ready":true,"recommendation":"advanced","constraints":[],"assumptions":[]}',
    ]);
    f.replies.set("final-review", ['{"classification":"SIMPLE"}']);
    f.replies.set("audit-economic", ['{"findings":[]}']);
    const router = await f.client.createAgent({
      provider: "codex",
      cwd: f.directory,
      workspaceId: f.workspace.id,
      launchProfileId: "paseo-workflow-router",
      modeId: "full-access",
    });
    await f.client.sendMessage(router.id, "Build a compatible feature");
    await expect.poll(() => f.agents("planner").length).toBe(1);
    const planner = f.agents("planner")[0]!;
    await expect.poll(() => planner.lifecycle).toBe("idle");
    const clarification = (
      "Clarification: retain the CSV export without adding dependencies. " +
      "Detailed requirement. ".repeat(500)
    ).trim();
    await f.client.sendMessage(planner.id, clarification);
    await expect.poll(() => f.agents("planner")[0]?.lifecycle).toBe("idle");
    for (let index = 0; index < 11; index++) {
      await f.client.sendMessage(planner.id, `Additional clarification ${index}`);
      await expect.poll(() => f.agents("planner")[0]?.lifecycle).toBe("idle");
    }
    const reviewPlan = await pendingPlan(f, planner.id);
    expect(
      f.daemon.daemon.agentManager
        .getTimeline(planner.id)
        .find((item) => item.type === "user_message" && item.text.startsWith("Clarification:")),
    ).toMatchObject({ text: clarification });
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", reviewPlan);
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[router.id]?.plans[reviewPlan.callId]?.review?.phase,
      )
      .toBe("complete");
    await expect.poll(() => planner.lifecycle).toBe("idle");
    const plan = await pendingPlan(f, planner.id, "plan-2");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.handoff.request", {
      ...plan,
      selection: "advanced",
    });
    const executor = f.agents("executor-advanced")[0]!;
    await expect.poll(() => executor.lifecycle).toBe("idle");
    await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
    f.git("add", "feature.txt");
    f.git("commit", "--quiet", "-m", "functional");
    await f.client.sendMessage(executor.id, "Implemented and committed");
    await expect
      .poll(() => f.prompts.filter((prompt) => prompt.role === "final-review").length)
      .toBeGreaterThan(0);
    for (const role of ["plan-reviewer", "executor-advanced", "final-review"])
      expect(
        f.prompts.find((prompt) => prompt.role === role)?.text.includes(clarification),
        role,
      ).toBe(true);
    await f.client.reloadPlugin("paseo-workflow");
    expect(
      await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: planner.id,
        workspaceId: plan.workspaceId,
      }),
    ).toMatchObject({ handoff: { selection: "advanced", phase: "running", agentId: executor.id } });
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["initial", "final"])(
  "untracked files at %s snapshot prevent completion even with empty audits",
  async (when) => {
    const f = await lifecycleFixture();
    try {
      f.replies.set("final-review", ['{"classification":"SIMPLE"}']);
      f.replies.set("audit-economic", ['{"findings":[]}']);
      const plan = await pendingPlan(f);
      if (when === "initial")
        await writeFile(path.join(f.directory, "untracked.txt"), "not in git diff\n");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
      const state = (await f.read()).values;
      state.workflows[plan.agentId]!.activePlanId = plan.callId;
      state.workflows[plan.agentId]!.plans[plan.callId]!.approved = true;
      await f.write(state);
      f.daemon.daemon.agentManager.getAgent(plan.agentId)!.pendingPermissions.clear();
      await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
      f.git("add", "feature.txt");
      f.git("commit", "--quiet", "-m", "functional");
      if (when === "final")
        await writeFile(path.join(f.directory, "untracked.txt"), "not in git diff\n");
      await f.client.sendMessage(plan.agentId, "Implemented and committed");
      await expect
        .poll(
          async () =>
            (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
          { timeout: 10_000 },
        )
        .toBe("verification_required");
      expect(f.git("diff", state.workflows[plan.agentId]!.git.base)).not.toContain("untracked.txt");
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("review RPC leaves the real permission retryable when reviewer creation fails", async () => {
  const f = await lifecycleFixture();
  try {
    const plan = await pendingPlan(f);
    f.failures.set("plan-reviewer", 1);
    await expect(
      f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan),
    ).rejects.toThrow("spawn failure");
    expect(
      f.daemon.daemon.agentManager
        .getAgent(plan.agentId)!
        .pendingPermissions.has(plan.permissionRequestId),
    ).toBe(true);
    const retry = await f.client.invokePluginRpc(
      "paseo-workflow",
      "workflow.plan.review.request",
      plan,
    );
    expect(retry).toMatchObject({ type: "workflow.plan.review.response" });
    expect(f.agents("plan-reviewer")).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("review completed during plugin downtime reconciles from the real timeline exactly once", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    f.replies.set("plan-reviewer", ["Clarify the backward compatibility constraint"]);
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await f.client.disablePlugin("paseo-workflow");
    release();
    await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
    await f.client.enablePlugin("paseo-workflow");
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase,
      )
      .toBe("complete");
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect(
      f.prompts.filter(
        (prompt) => prompt.role === "planner" && prompt.text.startsWith("Revise the plan"),
      ),
    ).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test.each([false, true])(
  "real Router lifecycle uses its ready JSON turn after an interactive question (reused turnId: %s)",
  async (reuse) => {
    const f = await lifecycleFixture();
    try {
      if (reuse) f.reusedTurnIds.add("router");
      f.replies.set("router", [
        "Which compatibility must remain?",
        JSON.stringify({
          ready: true,
          recommendation: "advanced",
          constraints: ["Keep old clients"],
          assumptions: [],
        }),
      ]);
      const router = await f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId: "paseo-workflow-router",
        modeId: "full-access",
      });
      await f.client.sendMessage(router.id, "Build the feature");
      await expect
        .poll(() =>
          f.daemon.daemon.agentManager
            .getTimeline(router.id)
            .some(
              (item) => item.type === "assistant_message" && item.text.includes("compatibility"),
            ),
        )
        .toBe(true);
      await expect.poll(() => f.agents("router")[0]?.lifecycle).toBe("idle");
      expect(f.agents("planner")).toHaveLength(0);
      if (reuse) await f.daemon.daemon.agentManager.closeAgent(router.id);
      await f.client.sendMessage(router.id, "Keep old clients working");
      await expect.poll(() => f.agents("planner").length, { timeout: 10_000 }).toBe(1);
      await expect
        .poll(async () => (await f.read()).values.workflows[router.id]?.routed)
        .toBe(true);
      expect((await f.read()).values.workflows[router.id]?.recommendation).toBe("advanced");
      expect(f.prompts.find((prompt) => prompt.role === "planner")?.text).toContain(
        "Keep old clients working",
      );
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("a later plugin hook cannot relax the Router policy before a real creation", async () => {
  const f = await lifecycleFixture();
  try {
    const plugin = path.join(f.directory, "later-hook");
    await mkdir(plugin);
    await writeFile(
      path.join(plugin, "paseo-plugin.json"),
      JSON.stringify({ id: "zzz-later-hook", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(plugin, "index.server.ts"),
      'export default function contribute(server) { server.before("agent.create", ({ request }) => ({ ...request, config: { ...request.config, writePolicy: "read_write" } })); return () => {}; }',
    );
    await f.client.installDirectoryPlugin(plugin);
    await expect(
      f.client.createAgent({
        provider: "codex",
        cwd: f.directory,
        workspaceId: f.workspace.id,
        launchProfileId: "paseo-workflow-router",
        modeId: "full-access",
      }),
    ).rejects.toThrow("cannot relax read_only");
    expect(f.agents("router")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 60_000);

test("two audits finished during downtime reconcile once, with no repeated manager report", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holds.set("audit-deep", held);
  f.holds.set("audit-security", held);
  try {
    f.replies.set("final-review", ['{"classification":"SENSITIVE"}']);
    f.replies.set("audit-deep", ['{"findings":[]}']);
    f.replies.set("audit-security", ['{"findings":[]}']);
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.handoff.prepare.request", plan);
    const state = (await f.read()).values;
    state.workflows[plan.agentId]!.activePlanId = plan.callId;
    state.workflows[plan.agentId]!.plans[plan.callId]!.approved = true;
    await f.write(state);
    f.daemon.daemon.agentManager.getAgent(plan.agentId)!.pendingPermissions.clear();
    await writeFile(path.join(f.directory, "feature.txt"), "functional\n");
    f.git("add", "feature.txt");
    f.git("commit", "--quiet", "-m", "functional");
    await f.client.sendMessage(plan.agentId, "Implemented and committed");
    await expect
      .poll(
        async () =>
          (await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase,
      )
      .toBe("auditing");
    await f.client.disablePlugin("paseo-workflow");
    release();
    await expect
      .poll(() => [f.agents("audit-deep")[0]?.lifecycle, f.agents("audit-security")[0]?.lifecycle])
      .toEqual(["idle", "idle"]);
    await f.client.enablePlugin("paseo-workflow");
    for (let pass = 0; pass < 2; pass++) {
      await f.client.reloadPlugin("paseo-workflow");
      await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
      });
    }
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.final?.phase).toBe(
      "complete",
    );
    expect(
      f.prompts.filter((prompt) => prompt.text.startsWith("The audits found no defects")),
    ).toHaveLength(1);
    expect(f.agents("audit-deep")).toHaveLength(1);
    expect(f.agents("audit-security")).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test("a canceled reviewer is not reconciled as completed after reload", async () => {
  const f = await lifecycleFixture();
  let release!: () => void;
  f.holds.set(
    "plan-reviewer",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.canceled.add("plan-reviewer");
  try {
    const plan = await pendingPlan(f);
    await f.client.invokePluginRpc("paseo-workflow", "workflow.plan.review.request", plan);
    await f.client.disablePlugin("paseo-workflow");
    release();
    await expect.poll(() => f.agents("plan-reviewer")[0]?.lifecycle).toBe("idle");
    const reviewer = f.agents("plan-reviewer")[0]!;
    expect(reviewer.lastCompletedTurnId).toBeUndefined();
    await f.daemon.daemon.agentManager.flush();
    await f.client.enablePlugin("paseo-workflow");
    await f.client.reloadPlugin("paseo-workflow");
    await f.client.invokePluginRpc("paseo-workflow", "workflow.status.get.request", {
      agentId: plan.agentId,
      workspaceId: plan.workspaceId,
    });
    expect((await f.read()).values.workflows[plan.agentId]?.plans[plan.callId]?.review?.phase).toBe(
      "running",
    );
    expect(f.prompts.filter((prompt) => prompt.text.startsWith("Revise the plan"))).toHaveLength(0);
  } finally {
    release();
    await f.close();
  }
}, 60_000);

test("the first-party workflow compiles in a real subprocess and installs profiles only by explicit RPC", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const custom = {
    id: "paseo-workflow-router",
    name: "My Router",
    provider: "codex",
    model: "custom-model",
    foreign: { preserve: true },
  };
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true, agentProfiles: [custom] });
    await client.installDirectoryPlugin(path.resolve("plugins/paseo-workflow"));
    expect((await client.getDaemonConfig()).config.agentProfiles).toEqual([custom]);
    const result = await client.invokePluginRpc(
      "paseo-workflow",
      "workflow.profiles.install.request",
      {},
    );
    expect(result).toMatchObject({ type: "workflow.profiles.install.response", count: 9 });
    expect((await client.getDaemonConfig()).config.agentProfiles?.[0]).toEqual(custom);
    await client.reloadPlugin("paseo-workflow");
    await client.invokePluginRpc("paseo-workflow", "workflow.profiles.install.request", {});
    expect((await client.getDaemonConfig()).config.agentProfiles).toHaveLength(9);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

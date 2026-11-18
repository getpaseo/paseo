import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import { toAgentPayload } from "../agent-projections.js";
import { cancelAgentRunCommand } from "../lifecycle-command.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

const logger = createTestLogger();

interface PendingPlanLifecycle {
  close(): Promise<void>;
  crashDuringActiveTurn(): Promise<void>;
  expectCanceledPlan(): void;
}

async function withPendingPlan(
  runScenario: (plan: PendingPlanLifecycle) => Promise<void>,
): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), "codex-plan-cancel-"));
  const appServer = createFakeCodexAppServer();
  const client = new ProcessExitCodexClient([appServer]);
  const session = await client.createSession({
    provider: "codex",
    cwd: workdir,
    modeId: "auto",
    model: "gpt-5.4",
    providerOptions: { plan_mode: true },
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const run = session.run("make a plan");
    await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "plan-turn" });
    appServer.updatesPlan({ threadId: "thread-1", steps: ["Inspect README"] });
    appServer.completeTurn();
    await run;
    const proposal = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.name === "plan_approval",
    );
    expect(proposal).toBeDefined();
    const [request] = session.getPendingPermissions?.() ?? [];
    expect(request).toBeDefined();
    await runScenario({
      close: () => session.close(),
      async crashDuringActiveTurn() {
        appServer.startsTurn({ threadId: "thread-1", turnId: "autonomous-turn" });
        await expect
          .poll(() => events.filter((event) => event.type === "turn_started").length)
          .toBe(2);
        appServer.child.emit("exit", 17, null);
        await expect.poll(() => events.some((event) => event.type === "turn_failed")).toBe(true);
      },
      expectCanceledPlan() {
        expect(session.getPendingPermissions?.()).toEqual([]);
        expect(events).toContainEqual({
          ...proposal,
          item: expect.objectContaining({
            type: "tool_call",
            name: "plan_approval",
            callId: request?.id,
            status: "canceled",
            detail: { type: "plan", text: "- Inspect README" },
          }),
        });
      },
    });
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("closing a session retains a canceled pending plan", async () => {
  await withPendingPlan(async (plan) => {
    await plan.close();
    plan.expectCanceledPlan();
  });
});

test("an active provider crash retains a canceled pending plan", async () => {
  await withPendingPlan(async (plan) => {
    await plan.crashDuringActiveTurn();
    plan.expectCanceledPlan();
  });
});

class ProcessExitCodexClient extends CodexAppServerAgentClient implements AgentClient {
  constructor(private readonly appServers: FakeCodexAppServer[]) {
    super(logger);
  }

  override async isAvailable(): Promise<boolean> {
    return true;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new CodexAppServerAgentSession(
      config,
      null,
      logger,
      async () => {
        const appServer = this.appServers.shift();
        if (!appServer) {
          throw new Error("No fake Codex app-server available");
        }
        return appServer.child;
      },
      {},
      false,
      false,
      false,
      launchContext?.agentId,
    );
    await session.connect();
    return session;
  }
}

test("unexpected Codex app-server exit fails the active run and agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-exit-"));
  const appServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    const run = manager.runAgent(agent.id, "keep working");
    const turnStart = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: String(turnStart.threadId), turnId: "native-turn-1" });
    await manager.waitForAgentRunStart(agent.id);

    appServer.child.stderr.write("provider crashed");
    appServer.child.emit("exit", 17, null);
    appServer.child.emit("exit", 17, null);

    await expect(run).rejects.toThrow(
      "Codex app-server exited with code 17 and signal null\nprovider crashed",
    );
    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("error");
    expect(manager.getAgent(agent.id)?.lastError).toBe(
      "Codex app-server exited with code 17 and signal null\nprovider crashed",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent_stream",
        agentId: agent.id,
        event: expect.objectContaining({
          type: "turn_failed",
          error: "Codex app-server exited with code 17 and signal null\nprovider crashed",
        }),
      }),
    );
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(1);
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("replacement self-heals when Codex reports that the tracked turn is already idle", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-already-idle-replace-"));
  const appServer = createFakeCodexAppServer({
    "turn/interrupt": () => ({
      __jsonRpcError: { code: -32600, message: "no active turn to interrupt" },
    }),
  });
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    const firstRun = manager.runAgent(agent.id, "keep working");
    const firstTurnStart = await appServer.waitForTurnStart();
    appServer.startsTurn({
      threadId: String(firstTurnStart.threadId),
      turnId: "native-turn-already-idle",
    });
    await manager.waitForAgentRunStart(agent.id);

    const replacementStream = await manager.replaceAgentRun(agent.id, "replacement prompt");
    const replacementEvents = (async () => {
      const events = [];
      for await (const event of replacementStream) {
        events.push(event);
      }
      return events;
    })();

    await expect
      .poll(() => appServer.requests().filter((message) => message.method === "turn/start").length)
      .toBe(2);
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-turn-replacement" });
    appServer.completeTurn({ threadId: "thread-1" });

    await expect(firstRun).resolves.toMatchObject({ canceled: true });
    await expect(replacementEvents).resolves.toContainEqual(
      expect.objectContaining({ type: "turn_completed" }),
    );
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("intentional agent close stays clean while a Codex turn is active", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-close-"));
  const appServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    const run = manager.streamAgent(agent.id, "keep working");
    const drainRun = (async () => {
      const runEvents = [];
      for await (const event of run) {
        runEvents.push(event);
      }
      return runEvents;
    })();
    const turnStart = await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: String(turnStart.threadId), turnId: "native-turn-1" });
    await manager.waitForAgentRunStart(agent.id);

    await manager.closeAgent(agent.id);

    await expect(drainRun).resolves.toContainEqual(
      expect.objectContaining({ type: "turn_canceled", reason: "agent closed" }),
    );
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent_state",
        agent: expect.objectContaining({ id: agent.id, lifecycle: "closed" }),
      }),
    );
  } finally {
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("idle Codex app-server exit reconnects without publishing a failed turn", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-idle-exit-"));
  const exitedAppServer = createFakeCodexAppServer();
  const replacementAppServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, replacementAppServer]),
    },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;

    exitedAppServer.child.emit("exit", 17, null);

    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(0);

    const run = manager.runAgent(agent.id, "continue after reconnect");
    const turnStart = await replacementAppServer.waitForTurnStart();
    replacementAppServer.startsTurn({
      threadId: String(turnStart.threadId),
      turnId: "native-turn-2",
    });
    replacementAppServer.completeTurn({ threadId: String(turnStart.threadId) });

    await expect(run).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("failed reconnect preserves manager events for a later successful run", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-reconnect-failure-"));
  const exitedAppServer = createFakeCodexAppServer();
  const failedReconnect = createFakeCodexAppServer({
    initialize: async () => {
      throw new Error("reconnect failed");
    },
  });
  const successfulReconnect = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, failedReconnect, successfulReconnect]),
    },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    exitedAppServer.child.emit("exit", 17, null);

    await expect(manager.runAgent(agent.id, "first reconnect")).rejects.toThrow("reconnect failed");

    const run = manager.runAgent(agent.id, "second reconnect");
    const turnStart = await successfulReconnect.waitForTurnStart();
    successfulReconnect.startsTurn({
      threadId: String(turnStart.threadId),
      turnId: "native-turn-3",
    });
    successfulReconnect.completeTurn({ threadId: String(turnStart.threadId) });

    await expect(run).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("unexpected exit fails an autonomous Codex turn", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-autonomous-exit-"));
  const appServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([appServer]) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    appServer.startsTurn({ threadId: "thread-1", turnId: "autonomous-turn" });
    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("running");

    appServer.child.stderr.write("autonomous provider crashed");
    appServer.child.emit("exit", 23, null);

    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("error");
    expect(manager.getAgent(agent.id)?.lastError).toBe(
      "Codex app-server exited with code 23 and signal null\nautonomous provider crashed",
    );
    expect(
      events.filter((event) => event.type === "agent_stream" && event.event.type === "turn_failed"),
    ).toHaveLength(1);
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    unsubscribe();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider permissions do not survive an unexpected exit and reconnect", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-permission-exit-"));
  const exitedAppServer = createFakeCodexAppServer();
  const replacementAppServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, replacementAppServer]),
    },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;

    const failedRun = manager.runAgent(agent.id, "run a command");
    const failedTurnStart = await exitedAppServer.waitForTurnStart();
    const failedThreadId = String(failedTurnStart.threadId);
    exitedAppServer.startsTurn({ threadId: failedThreadId, turnId: "native-turn-1" });
    exitedAppServer.requestCommandApproval({
      itemId: "stale-command",
      threadId: failedThreadId,
      turnId: "native-turn-1",
      command: "git status",
      cwd: workdir,
      reason: "confirm command",
    });
    await expect
      .poll(() => manager.getPendingPermissions(agent.id).map((request) => request.id))
      .toEqual(["permission-stale-command"]);

    exitedAppServer.child.emit("exit", 17, null);

    await expect(failedRun).rejects.toThrow("Codex app-server exited with code 17");
    expect(manager.getPendingPermissions(agent.id)).toEqual([]);

    const recoveredRun = manager.runAgent(agent.id, "continue after reconnect");
    const recoveredTurnStart = await replacementAppServer.waitForTurnStart();
    const recoveredThreadId = String(recoveredTurnStart.threadId);
    replacementAppServer.startsTurn({
      threadId: recoveredThreadId,
      turnId: "native-turn-2",
    });
    replacementAppServer.requestCommandApproval({
      itemId: "new-command",
      threadId: recoveredThreadId,
      turnId: "native-turn-2",
      command: "git diff",
      cwd: workdir,
      reason: "confirm command",
    });
    await expect
      .poll(() => manager.getPendingPermissions(agent.id).map((request) => request.id))
      .toEqual(["permission-new-command"]);

    await manager.respondToPermission(agent.id, "permission-new-command", {
      behavior: "allow",
    });

    expect(manager.getPendingPermissions(agent.id)).toEqual([]);
    replacementAppServer.completeTurn({ threadId: recoveredThreadId });
    await expect(recoveredRun).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("idle provider exit preserves a synthetic plan approval across reconnect", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-plan-exit-"));
  const exitedAppServer = createFakeCodexAppServer();
  const replacementAppServer = createFakeCodexAppServer();
  const manager = new AgentManager({
    clients: {
      codex: new ProcessExitCodexClient([exitedAppServer, replacementAppServer]),
    },
    logger,
  });
  let agentId: string | null = null;

  try {
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
        modeId: "auto",
        model: "gpt-5.4",
        providerOptions: { plan_mode: true },
      },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;

    const planRun = manager.runAgent(agent.id, "make a plan");
    const planTurnStart = await exitedAppServer.waitForTurnStart();
    const planThreadId = String(planTurnStart.threadId);
    exitedAppServer.startsTurn({ threadId: planThreadId, turnId: "plan-turn" });
    exitedAppServer.updatesPlan({
      threadId: planThreadId,
      steps: ["Inspect the provider lifecycle", "Implement the fix"],
    });
    exitedAppServer.completeTurn({ threadId: planThreadId });
    await expect(planRun).resolves.toMatchObject({ sessionId: "thread-1" });
    const [planApproval] = manager.getPendingPermissions(agent.id);
    expect(planApproval).toMatchObject({
      name: "CodexPlanApproval",
      kind: "plan",
    });

    exitedAppServer.child.emit("exit", 17, null);

    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(manager.getPendingPermissions(agent.id)).toEqual([planApproval]);
    const approval = await manager.respondToPermission(agent.id, planApproval!.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    expect(approval).toMatchObject({
      followUpPrompt: expect.stringContaining("Implement the fix"),
    });

    const implementationRun = manager.runAgent(agent.id, approval!.followUpPrompt!);
    const implementationTurnStart = await replacementAppServer.waitForTurnStart();
    const implementationThreadId = String(implementationTurnStart.threadId);
    replacementAppServer.startsTurn({
      threadId: implementationThreadId,
      turnId: "implementation-turn",
    });
    replacementAppServer.completeTurn({ threadId: implementationThreadId });
    await expect(implementationRun).resolves.toMatchObject({ sessionId: "thread-1" });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId && manager.getAgent(agentId)) {
      await manager.closeAgent(agentId);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("concurrent session APIs share one reconnect after an idle provider exit", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-concurrent-reconnect-"));
  const appServers = [
    createFakeCodexAppServer(),
    createFakeCodexAppServer(),
    createFakeCodexAppServer(),
  ];
  let spawnCount = 0;
  let markReconnectStarted!: () => void;
  const reconnectStarted = new Promise<void>((resolve) => {
    markReconnectStarted = resolve;
  });
  let releaseReconnect: (() => void) | undefined;
  const reconnectGate = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      const appServer = appServers[spawnCount];
      if (!appServer) {
        throw new Error("No fake Codex app-server available");
      }
      spawnCount += 1;
      if (spawnCount > 1) {
        markReconnectStarted();
        await reconnectGate;
      }
      return appServer.child;
    },
  );

  try {
    await session.connect();
    appServers[0]!.child.emit("exit", 17, null);

    const runtimeInfo = session.getRuntimeInfo();
    const turnStart = session.startTurn("continue after reconnect");
    await reconnectStarted;
    const reconnectSpawnCount = spawnCount - 1;
    releaseReconnect?.();

    await expect(runtimeInfo).resolves.toMatchObject({ provider: "codex" });
    await expect(turnStart).resolves.toMatchObject({ turnId: expect.any(String) });
    expect(reconnectSpawnCount).toBe(1);
    expect(spawnCount).toBe(2);
  } finally {
    releaseReconnect?.();
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session close disposes a provider that arrives from an in-flight reconnect", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-process-close-reconnect-"));
  const initialAppServer = createFakeCodexAppServer();
  const lateAppServer = createFakeCodexAppServer();
  let spawnCount = 0;
  let markReconnectSpawned: (() => void) | undefined;
  const reconnectSpawned = new Promise<void>((resolve) => {
    markReconnectSpawned = resolve;
  });
  let releaseReconnect: (() => void) | undefined;
  const reconnectGate = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return initialAppServer.child;
      }
      markReconnectSpawned?.();
      await reconnectGate;
      return lateAppServer.child;
    },
  );
  const events: AgentManagerEvent[] = [];
  session.subscribe((event) => {
    events.push({ type: "agent_stream", agentId: "test-agent", event });
  });
  const lateExit = new Promise<void>((resolve) => {
    lateAppServer.child.once("exit", () => resolve());
  });

  try {
    await session.connect();
    initialAppServer.child.emit("exit", 17, null);

    const turnStart = session.startTurn("continue after reconnect");
    await reconnectSpawned;
    await session.close();
    releaseReconnect?.();

    await expect(turnStart).rejects.toThrow("Codex app-server session is closed");
    await expect(lateExit).resolves.toBeUndefined();
    expect(events.filter((event) => event.event.type === "turn_failed")).toHaveLength(0);

    await expect(session.connect()).rejects.toThrow("Codex app-server session is closed");
    expect(spawnCount).toBe(2);
  } finally {
    releaseReconnect?.();
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("replacement retires an unresponsive Codex app-server before resuming the saved thread", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-interrupt-recovery-"));
  const stalled = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const resumed = createFakeCodexAppServer();
  let oldExited = false;
  stalled.child.once("exit", () => {
    oldExited = true;
  });
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([stalled, resumed]) },
    logger,
  });
  let agentId: string | null = null;
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    agentId = agent.id;
    const first = manager.runAgent(agent.id, "working before pressure");
    void first.catch(() => undefined);
    const start = await stalled.waitForTurnStart();
    stalled.startsTurn({ threadId: String(start.threadId), turnId: "stalled-turn" });
    await manager.waitForAgentRunStart(agent.id);
    const replacement = await manager.replaceAgentRun(agent.id, "replacement after pressure");
    expect(oldExited).toBe(true);
    const result = (async () => {
      for await (const _event of replacement) {
      }
    })();
    const resumedStart = await resumed.waitForTurnStart();
    expect(resumedStart.threadId).toBe(start.threadId);
    expect(resumed.requests()).toContainEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: start.threadId }),
      }),
    );
    resumed.startsTurn({ threadId: String(start.threadId), turnId: "resumed-turn" });
    resumed.completeTurn({ threadId: String(start.threadId) });
    await result;
    await expect(first).resolves.toMatchObject({ canceled: true });
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    if (agentId) await manager.closeAgent(agentId);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("failed Codex process retirement retains ownership and Stop can retry it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-interrupt-refused-"));
  const stalled = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  stalled.child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const client = new ProcessExitCodexClient([stalled, createFakeCodexAppServer()]);
  const session = await client.createSession({ provider: "codex", cwd: workdir, modeId: "auto" });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const run = session.run("keep working");
    void run.catch(() => undefined);
    const start = await stalled.waitForTurnStart();
    stalled.startsTurn({ threadId: String(start.threadId), turnId: "unresponsive-turn" });
    await expect(session.interrupt()).rejects.toThrow("did not report exit after SIGKILL");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(session.startTurn("must not run concurrently")).rejects.toMatchObject({
      deliveryOutcome: "not_submitted",
    });
    stalled.child.exitCode = 0;
    stalled.child.emit("exit", 0, null);
    await session.interrupt();
    await expect(run).resolves.toMatchObject({ sessionId: start.threadId, finalText: "" });
    expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(1);
  } finally {
    stalled.child.exitCode = 0;
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a lost interrupt reply does not retire a newer autonomous Codex turn", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-interrupt-new-turn-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  let exited = false;
  appServer.child.once("exit", () => {
    exited = true;
  });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.startTurn("first turn");
    appServer.startsTurn({ threadId: "thread-1", turnId: "old-turn" });
    const interrupt = session.interrupt();
    await appServer.waitForRequest("turn/interrupt");
    appServer.completeTurn({ threadId: "thread-1" });
    appServer.startsTurn({ threadId: "thread-1", turnId: "new-autonomous-turn" });
    await interrupt;
    expect(exited).toBe(false);
    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
    expect(appServer.requests().filter((request) => request.method === "turn/start")).toHaveLength(
      1,
    );
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a timed-out autonomous interrupt leaves its successor running", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-autonomous-interrupt-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  let exited = false;
  appServer.child.once("exit", () => {
    exited = true;
  });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.startTurn("first turn");
    appServer.startsTurn({ threadId: "thread-1", turnId: "initial-turn" });
    appServer.completeTurn({ threadId: "thread-1" });
    appServer.startsTurn({ threadId: "thread-1", turnId: "old-autonomous-turn" });
    await expect.poll(() => events.filter((event) => event.type === "turn_started").length).toBe(2);
    const interrupt = session.interrupt();
    await appServer.waitForRequest("turn/interrupt");
    appServer.completeTurn({ threadId: "thread-1" });
    appServer.startsTurn({ threadId: "thread-1", turnId: "successor-turn" });
    await interrupt;
    expect(exited).toBe(false);
    expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("interrupt retirement dismisses async questions before cancellation and persistence", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-interrupt-question-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const config: AgentSessionConfig = { provider: "codex", cwd: workdir, modeId: "auto" };
  const session = await new ProcessExitCodexClient([appServer]).createSession(config);
  const permissionsAtCancellation: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "turn_canceled")
      permissionsAtCancellation.push(session.getPendingPermissions());
  });
  try {
    await session.startTurn("ask a question");
    appServer.startsTurn({ threadId: "thread-1", turnId: "question-turn" });
    appServer.asksAsyncQuestion({ threadId: "thread-1", turnId: "question-turn" });
    await expect
      .poll(() => session.getPendingPermissions().map((request) => request.id))
      .toEqual(["permission-async-question"]);
    await session.interrupt();
    expect(permissionsAtCancellation).toEqual([[]]);
    const persistence = session.describePersistence();
    expect(persistence?.metadata?.asyncQuestions).toEqual([
      expect.objectContaining({ resolution: "dismissed" }),
    ]);
    const reopened = new CodexAppServerAgentSession(
      config,
      persistence,
      logger,
      async () => createFakeCodexAppServer().child,
    );
    expect(reopened.getPendingPermissions()).toEqual([]);
    await reopened.close();
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("interrupt retirement completes pending compaction before cancellation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-interrupt-compaction-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
    modeId: "auto",
  });
  const lifecycle: string[] = [];
  session.subscribe((event) => {
    if (event.type === "turn_canceled") lifecycle.push("canceled");
    if (event.type === "timeline" && event.item.type === "compaction")
      lifecycle.push(event.item.status);
  });
  try {
    await session.startTurn("compact this conversation");
    appServer.startsTurn({ threadId: "thread-1", turnId: "compacting-turn" });
    appServer.startsCompaction({ threadId: "thread-1", itemId: "pending-compaction" });
    await expect.poll(() => lifecycle).toEqual(["loading"]);
    await session.interrupt();
    expect(lifecycle).toEqual(["loading", "completed", "canceled"]);
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("interrupt retirement cancels native question rows", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-retire-native-question-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
    modeId: "auto",
  });
  const statuses: string[] = [];
  session.subscribe((event) => {
    if (
      event.type === "timeline" &&
      event.item.type === "tool_call" &&
      event.item.callId === "question"
    )
      statuses.push(event.item.status);
    if (event.type === "turn_canceled") statuses.push("turn_canceled");
  });
  try {
    await session.startTurn("ask me");
    appServer.startsTurn({ threadId: "thread-1", turnId: "turn" });
    appServer.requestUserInput({
      threadId: "thread-1",
      turnId: "turn",
      itemId: "question",
      questions: [
        { id: "choice", header: "Choice", question: "Which?", options: [{ label: "One" }] },
      ],
    });
    await expect.poll(() => statuses).toEqual(["running"]);
    await session.interrupt();
    expect(statuses).toEqual(["running", "canceled", "turn_canceled"]);
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("interrupt retirement completes child compaction markers", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-retire-child-compaction-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
    modeId: "auto",
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  const statuses = () =>
    events.flatMap((event) =>
      event.type === "provider_subagent" &&
      event.event.type === "timeline" &&
      event.event.item.type === "compaction"
        ? [event.event.item.status]
        : [],
    );
  try {
    await session.startTurn("start child");
    appServer.startsTurn({ threadId: "thread-1", turnId: "turn" });
    appServer.startsSubAgent({
      callId: "spawn",
      threadId: "child",
      agentPath: "/root/child",
      parentThreadId: "thread-1",
    });
    appServer.startsCompaction({ threadId: "child", itemId: "child-compaction" });
    await expect.poll(statuses).toEqual(["loading"]);
    await session.interrupt();
    expect(statuses()).toEqual(["loading", "completed"]);
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

for (const timeline of ["root", "child"] as const) {
  test(`interrupt retirement settles ordinary tools in the ${timeline} timeline`, async () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-retire-tool-"));
    const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
    const session = await new ProcessExitCodexClient([appServer]).createSession({
      provider: "codex",
      cwd: workdir,
      modeId: "auto",
    });
    const statuses: string[] = [];
    session.subscribe((event) => {
      let item;
      if (event.type === "timeline") item = event.item;
      else if (event.type === "provider_subagent" && event.event.type === "timeline")
        item = event.event.item;
      if (item?.type === "tool_call" && item.callId === "running-tool") statuses.push(item.status);
    });
    try {
      await session.startTurn("run a tool");
      appServer.startsTurn({ threadId: "thread-1", turnId: "turn" });
      if (timeline === "child")
        appServer.startsSubAgent({
          callId: "spawn",
          threadId: "child",
          parentThreadId: "thread-1",
          agentPath: "/root/child",
        });
      appServer.startsTerminalCommand({
        threadId: timeline === "root" ? "thread-1" : "child",
        turnId: "turn",
        itemId: "running-tool",
        command: "sleep 7200",
      });
      await expect.poll(() => statuses).toEqual(["running"]);
      await session.interrupt();
      expect(statuses).toEqual(["running", "canceled"]);
    } finally {
      await session.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}

for (const stop of [false, true]) {
  test(`a lost Codex start acknowledgement ${stop ? "can be stopped" : "retires its runtime"} without claiming non-delivery`, async () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-start-unknown-"));
    const old = createFakeCodexAppServer({ "turn/start": () => new Promise(() => {}) });
    const replacement = createFakeCodexAppServer();
    const session = await new ProcessExitCodexClient([old, replacement]).createSession({
      provider: "codex",
      cwd: workdir,
      modeId: "auto",
    });
    let exited = false;
    old.child.once("exit", () => {
      exited = true;
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const starting = session.startTurn("possibly accepted");
      const rejected = expect(starting).rejects.toMatchObject({ deliveryOutcome: "unknown" });
      await old.waitForRequest("turn/start");
      old.startsTurn({ threadId: "thread-1", turnId: "native-start" });
      if (stop) {
        const stopping = session.interrupt();
        await vi.advanceTimersByTimeAsync(5_100);
        await stopping;
      } else await vi.advanceTimersByTimeAsync(90_100);
      await rejected;
      expect(exited).toBe(true);
      vi.useRealTimers();
      await expect(session.startTurn("new prompt")).resolves.toEqual({
        turnId: expect.any(String),
      });
      expect(old.requests().filter((request) => request.method === "turn/start")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await session.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}

test("a lost steer acknowledgement has a bounded wait so Stop can proceed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-steer-unknown-"));
  const appServer = createFakeCodexAppServer({
    "turn/steer": () => new Promise(() => {}),
    "turn/interrupt": () => ({}),
  });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
    modeId: "auto",
  });
  try {
    const start = await session.startTurn("keep working");
    appServer.startsTurn({ threadId: "thread-1", turnId: "native-turn" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const steering = session.steerActiveTurn!("follow-up", { expectedTurnId: start.turnId });
    const rejected = expect(steering).rejects.toMatchObject({ deliveryOutcome: "unknown" });
    await appServer.waitForRequest("turn/steer");
    await vi.advanceTimersByTimeAsync(5_100);
    await rejected;
    const stopping = session.interrupt();
    await appServer.waitForRequest("turn/interrupt");
    appServer.completeTurn({ threadId: "thread-1" });
    await stopping;
  } finally {
    vi.useRealTimers();
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("retiring a later turn settles background tools under their original turn identity", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-background-tool-turn-"));
  const appServer = createFakeCodexAppServer({ "turn/interrupt": () => new Promise(() => {}) });
  const session = await new ProcessExitCodexClient([appServer]).createSession({
    provider: "codex",
    cwd: workdir,
  });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const first = session.run("start background shell");
    await appServer.waitForTurnStart();
    appServer.startsTurn({ threadId: "thread-1", turnId: "first-turn" });
    appServer.startsTerminalCommand({
      threadId: "thread-1",
      turnId: "first-turn",
      itemId: "background-tool",
      command: "sleep 7200",
    });
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.callId === "background-tool",
        ),
      )
      .toBe(true);
    const originalTurnId = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.callId === "background-tool",
    )?.turnId;
    expect(originalTurnId).toBeTruthy();
    appServer.completeTurn({ turnId: "first-turn" });
    await first;
    await session.startTurn("next turn");
    appServer.startsTurn({ threadId: "thread-1", turnId: "second-turn" });
    await session.interrupt();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        turnId: originalTurnId,
        item: expect.objectContaining({
          type: "tool_call",
          callId: "background-tool",
          status: "canceled",
        }),
      }),
    );
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("the public Stop command can retry a failed startup retirement after its run is cleared", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-start-stop-recovery-"));
  const old = createFakeCodexAppServer({ "turn/start": () => new Promise(() => {}) });
  old.child.kill = () => true;
  const manager = new AgentManager({
    clients: { codex: new ProcessExitCodexClient([old]) },
    logger,
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = manager.runAgent(agent.id, "possibly started");
    const failed = expect(run).rejects.toMatchObject({ deliveryOutcome: "unknown" });
    await old.waitForRequest("turn/start");
    await vi.advanceTimersByTimeAsync(94_000);
    await failed;
    expect(manager.hasInFlightRun(agent.id)).toBe(false);
    expect(toAgentPayload(manager.getAgent(agent.id)!).interruptRecoveryPending).toBe(true);
    const stopping = cancelAgentRunCommand({ agentManager: manager, logger }, agent.id);
    const refused = expect(stopping).rejects.toThrow("Try Stop again");
    await vi.advanceTimersByTimeAsync(4_000);
    await refused;
    expect(toAgentPayload(manager.getAgent(agent.id)!).interruptRecoveryPending).toBe(true);

    old.child.exitCode = 0;
    old.child.emit("exit", 0, null);
    await expect(
      cancelAgentRunCommand({ agentManager: manager, logger }, agent.id),
    ).resolves.toMatchObject({ cancelled: true });
    expect(toAgentPayload(manager.getAgent(agent.id)!).interruptRecoveryPending).toBe(false);
  } finally {
    vi.useRealTimers();
    old.child.exitCode = 0;
    await manager.closeAgent(agent.id);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("retiring a pre-submission startup leaves its cancellation event to the manager", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-unsubmitted-cancel-"));
  const old = createFakeCodexAppServer({ "thread/loaded/list": () => new Promise(() => {}) });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: workdir },
    null,
    logger,
    async () => old.child,
  );
  await session.getRuntimeInfo();
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const starting = session.startTurn("never submitted");
    const canceled = expect(starting).rejects.toThrow("canceled before starting");
    await old.waitForRequest("thread/loaded/list");
    await session.interrupt();
    await canceled;
    expect(old.requests().filter((request) => request.method === "turn/start")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn_canceled")).toEqual([]);
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

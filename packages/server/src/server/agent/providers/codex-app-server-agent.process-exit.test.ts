import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

const logger = createTestLogger();

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
        featureValues: { plan_mode: true },
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

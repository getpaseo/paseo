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
  constructor(private readonly appServer: FakeCodexAppServer) {
    super(logger);
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new CodexAppServerAgentSession(
      config,
      null,
      logger,
      async () => this.appServer.child,
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
    clients: { codex: new ProcessExitCodexClient(appServer) },
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
    clients: { codex: new ProcessExitCodexClient(appServer) },
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

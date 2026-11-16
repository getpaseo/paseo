import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createDaemonAgentMessageQueue, type AgentMessageQueue } from "./agent-message-queue.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/** A provider session the test drives by hand, including turns it starts on its own. */
class ControlledSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  interrupts = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turns = 0;

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const turnId = `turn-${++this.turns}`;
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {}
}

class ControlledClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions: ControlledSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new ControlledSession();
    this.sessions.push(session);
    return session;
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function createScenario(home?: string) {
  const paseoHome = home ?? (await mkdtemp(join(tmpdir(), "agent-message-queue-")));
  const logger = createTestLogger();
  const client = new ControlledClient();
  const agentStorage = new AgentStorage(join(paseoHome, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { codex: client },
    registry: agentStorage,
    logger,
  });
  const queue = createDaemonAgentMessageQueue({ agentManager, agentStorage, paseoHome, logger });
  cleanups.push(async () => {
    await queue.close();
    await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
    await agentStorage.flush();
    if (!home) await rm(paseoHome, { recursive: true, force: true });
  });
  return { paseoHome, client, agentManager, agentStorage, queue };
}

function submit(queue: AgentMessageQueue, agentId: string, text: string) {
  return queue.submit({ agentId, messageId: randomUUID(), prompt: text, text });
}

test("a message queued during compaction waits for it and never interrupts it", async () => {
  const { client, agentManager, queue } = await createScenario();
  const agent = await agentManager.createAgent({ provider: "codex", cwd: tmpdir() }, undefined, {
    workspaceId: undefined,
  });
  const session = client.sessions[0]!;

  // The provider compacts on its own: an autonomous turn with no prompt from Paseo.
  session.pushEvent({ type: "turn_started", provider: "codex", turnId: "compaction" });
  await expect.poll(() => agentManager.hasInFlightRun(agent.id)).toBe(true);

  await expect(submit(queue, agent.id, "after compaction")).resolves.toEqual({
    disposition: "queued",
    queuePosition: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(session.prompts).toEqual([]);
  expect(session.interrupts).toBe(0);
  expect(queue.list(agent.id).map((message) => message.preview)).toEqual(["after compaction"]);

  session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "compaction" });
  await expect.poll(() => session.prompts).toEqual(["after compaction"]);
  expect(session.interrupts).toBe(0);
  expect(queue.list(agent.id)).toEqual([]);
});

test("persisted messages survive a new queue and start once the agent is idle", async () => {
  const first = await createScenario();
  const agent = await first.agentManager.createAgent(
    { provider: "codex", cwd: tmpdir() },
    undefined,
    { workspaceId: undefined },
  );
  first.client.sessions[0]!.pushEvent({ type: "turn_started", provider: "codex", turnId: "busy" });
  await expect.poll(() => first.agentManager.hasInFlightRun(agent.id)).toBe(true);
  await submit(first.queue, agent.id, "one");
  await submit(first.queue, agent.id, "two");
  expect(await readdir(join(first.paseoHome, "agent-message-queue"))).toHaveLength(1);
  await first.queue.close();

  // A second queue over the same home stands in for the restarted daemon.
  const second = createDaemonAgentMessageQueue({
    agentManager: first.agentManager,
    agentStorage: first.agentStorage,
    paseoHome: first.paseoHome,
    logger: createTestLogger(),
  });
  cleanups.push(() => second.close());
  await second.start();
  expect(second.list(agent.id).map((message) => message.preview)).toEqual(["one", "two"]);

  first.client.sessions[0]!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: "busy",
  });
  await expect.poll(() => first.client.sessions[0]!.prompts).toEqual(["one", "two"]);
  await expect.poll(() => readdir(join(first.paseoHome, "agent-message-queue"))).toEqual([]);
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import { archiveAgentCommand } from "./lifecycle-command.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/** Provider session whose turns stay running until the test finishes them. */
class HeldTurnSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  interrupts = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;
  private announcedTurnId: string | null = null;

  constructor(readonly provider: AgentProvider) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    setTimeout(() => this.announceTurnStart(turnId), 0);
    return { turnId };
  }

  private announceTurnStart(turnId: string): void {
    if (this.announcedTurnId === turnId) return;
    this.announcedTurnId = turnId;
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
  }

  finishTurn(): void {
    const turnId = this.activeTurnId;
    if (!turnId) {
      throw new Error("No held turn to finish");
    }
    // A provider always announces a turn before it ends it.
    this.announceTurnStart(turnId);
    this.activeTurnId = null;
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
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
    const turnId = this.activeTurnId;
    if (!turnId) {
      return;
    }
    this.activeTurnId = null;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      reason: "interrupted",
      turnId,
    });
  }

  async close(): Promise<void> {}
}

class HeldTurnClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly sessions: HeldTurnSession[] = [];

  constructor(readonly provider: AgentProvider) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new HeldTurnSession(this.provider);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

interface QueueScenario {
  agentManager: AgentManager;
  storage: AgentStorage;
  agentId: string;
  client: HeldTurnClient;
  session: HeldTurnSession;
  send(prompt: string): ReturnType<typeof sendPromptToAgent>;
}

const logger = createTestLogger();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function createQueueScenario(): Promise<QueueScenario> {
  const workdir = await mkdtemp(join(tmpdir(), "agent-prompt-queue-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new HeldTurnClient("codex");
  const agentManager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });
  cleanups.push(async () => {
    await agentManager.flush();
    await storage.flush();
    await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const agent = await agentManager.createAgent(
    { provider: "codex", cwd: process.cwd() },
    undefined,
    {
      workspaceId: "wks_queue",
    },
  );
  return {
    agentManager,
    storage,
    agentId: agent.id,
    client,
    session: client.sessions[0]!,
    send: (prompt) =>
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: agent.id,
        prompt,
        activeTurnBehavior: "queue",
        logger,
      }),
  };
}

describe("queued messages", () => {
  it("start a turn right away when the agent is idle", async () => {
    const scenario = await createQueueScenario();

    const result = await scenario.send("first");

    expect(result).toEqual({ disposition: "turn_started" });
    await vi.waitFor(() => expect(scenario.session.prompts).toEqual(["first"]));
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );
  });

  it("hold the prompt until the running turn ends, without interrupting it", async () => {
    const scenario = await createQueueScenario();
    await scenario.send("first");
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );

    const result = await scenario.send("second");

    expect(result).toEqual({ disposition: "queued" });
    expect(scenario.session.interrupts).toBe(0);
    expect(scenario.session.prompts).toEqual(["first"]);

    scenario.session.finishTurn();

    await vi.waitFor(() => expect(scenario.session.prompts).toEqual(["first", "second"]));
    expect(scenario.session.interrupts).toBe(0);
  });

  it("run in the order they were sent, and the agent stays running until the last one ends", async () => {
    const scenario = await createQueueScenario();
    await scenario.send("first");
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );
    const lifecycles: string[] = [];
    scenario.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") lifecycles.push(event.agent.lifecycle);
      },
      { agentId: scenario.agentId, replayState: false },
    );

    expect(await scenario.send("second")).toEqual({ disposition: "queued" });
    expect(await scenario.send("third")).toEqual({ disposition: "queued" });

    scenario.session.finishTurn();
    await vi.waitFor(() => expect(scenario.session.prompts).toEqual(["first", "second"]));
    scenario.session.finishTurn();
    await vi.waitFor(() => expect(scenario.session.prompts).toEqual(["first", "second", "third"]));
    expect(lifecycles).not.toContain("idle");

    scenario.session.finishTurn();
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("idle"),
    );
  });

  it("stay queued when the running turn is interrupted, and run next", async () => {
    const scenario = await createQueueScenario();
    await scenario.send("first");
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );
    await scenario.send("second");

    await scenario.agentManager.cancelAgentRun(scenario.agentId);

    expect(scenario.session.interrupts).toBe(1);
    await vi.waitFor(() => expect(scenario.session.prompts).toEqual(["first", "second"]));
  });

  it("are dropped when the agent is archived", async () => {
    const scenario = await createQueueScenario();
    await scenario.send("first");
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );
    await scenario.send("second");

    await scenario.agentManager.archiveAgent(scenario.agentId);
    expect(scenario.session.prompts).toEqual(["first"]);

    // Sending again unarchives the agent into a fresh session. The dropped prompt must
    // not follow it there.
    expect(await scenario.send("third")).toEqual({ disposition: "turn_started" });
    const resumed = scenario.client.sessions[1]!;
    await vi.waitFor(() => expect(resumed.prompts).toEqual(["third"]));
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );
    resumed.finishTurn();
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("idle"),
    );
    expect(resumed.prompts).toEqual(["third"]);
  });

  it("are dropped, not started, when archiving interrupts the running turn", async () => {
    const scenario = await createQueueScenario();
    await scenario.send("first");
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running"),
    );
    await scenario.send("second");

    await archiveAgentCommand(
      { agentManager: scenario.agentManager, agentStorage: scenario.storage, logger },
      scenario.agentId,
    );

    expect(scenario.session.interrupts).toBe(1);
    expect(scenario.session.prompts).toEqual(["first"]);
  });
});

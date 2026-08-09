import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

/**
 * A session whose `startTurn` never resolves, modelling a provider that is slow to
 * accept a turn. The manager has a pending foreground run for it, but that run has
 * no turn id yet. `interrupt` resolves, so the manager treats the cancellation as
 * acknowledged even though nothing can settle the pending run.
 */
class StalledStartTurnSession implements AgentSession {
  readonly provider: AgentProvider = "claude";
  readonly id = "stalled-start-turn-session";
  readonly capabilities = CAPABILITIES;
  interruptCount = 0;

  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  startTurn(): Promise<{ turnId: string }> {
    return new Promise<{ turnId: string }>(() => {
      // Never resolves: the provider has not accepted the turn yet.
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // No history.
  }

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    // Acknowledged by the provider, but there is no accepted turn to cancel, so
    // nothing settles the manager's pending run.
    this.interruptCount += 1;
  }

  async close(): Promise<void> {}
}

class StalledStartTurnClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = CAPABILITIES;

  constructor(readonly session: StalledStartTurnSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    return this.session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

/**
 * A pending foreground run carries no turn id until the provider accepts the turn,
 * and `settleTerminalRun` ignores runs it cannot match by turn id. Cancellation
 * therefore cannot clear this run, and reporting it as "settled" made
 * `replaceAgentRun` continue into `streamAgent`, which rejected the prompt with
 * the misleading "already has an active run".
 */
test("replacing a run the provider never accepted reports a cancellation failure", async () => {
  const session = new StalledStartTurnSession();
  const manager = new AgentManager({
    clients: { claude: new StalledStartTurnClient(session) },
    logger: createTestLogger(),
    idFactory: () => "00000000-0000-4000-8000-000000003061",
  });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });

  // Start a run the provider never accepts, and drain it the way startAgentRun does.
  const first = manager.streamAgent(agent.id, "first prompt");
  void first.next().catch(() => {
    // The stalled turn never produces events.
  });
  expect(manager.hasInFlightRun(agent.id)).toBe(true);

  await expect(manager.replaceAgentRun(agent.id, "second prompt")).rejects.toThrow(
    `Cannot replace agent ${agent.id} because its active run cancellation was not acknowledged`,
  );
  expect(session.interruptCount).toBeGreaterThan(0);
}, 15_000);

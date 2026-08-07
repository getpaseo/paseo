import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * A session that is already busy with an autonomous provider turn Paseo never started,
 * and rejects any foreground prompt the way an ACP provider does: the turn is announced,
 * then the provider refuses it because its own turn is still in flight.
 */
class BusyRejectingSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;

  constructor(private readonly config: AgentSessionConfig) {}

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Mirrors acp-agent.startTurn: announce the turn, then reject it asynchronously. */
  async startTurn(): Promise<{ turnId: string }> {
    const turnId = `rejected-turn-${++this.turnCounter}`;
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({
        type: "turn_failed",
        provider: this.provider,
        turnId,
        error: "Invalid request: Cannot launch a new turn while another turn (ID 8) is active",
        rejected: true,
      });
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
    for (const cb of this.subscribers) {
      cb(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: null,
    };
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
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

class BusyRejectingClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  session: BusyRejectingSession | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.session = new BusyRejectingSession(config);
    return this.session;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.session = new BusyRejectingSession({
      ...config,
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
    });
    return this.session;
  }
}

async function drain(stream: AsyncGenerator<AgentStreamEvent>): Promise<void> {
  try {
    for await (const _event of stream) {
      // consume
    }
  } catch {
    // streamAgent rethrows the rejection; the agent state is what we assert on.
  }
}

/**
 * Repro for #2889.
 *
 * An ACP provider can be mid-turn on a turn Paseo never started, so the daemon sees no
 * `turn_started` for it and no terminal when it ends. A prompt sent during that window is
 * rejected by the provider with a busy error. The rejected turn is the only turn the daemon
 * tracks, so its failure is the last word on agent health: the agent sits at `error` until
 * some later prompt happens to succeed.
 */
test("a prompt the provider rejected as busy does not leave the agent stuck at error", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-busy-rejection-"));
  const client = new BusyRejectingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000002889",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  // The provider is busy with a turn the daemon never observed, so it rejects this prompt.
  await drain(manager.streamAgent(snapshot.id, "status?"));

  const afterRejection = manager.getAgent(snapshot.id);
  // The rejection belongs in the timeline, not in agent health.
  expect(afterRejection?.lifecycle).not.toBe("error");
  expect(afterRejection?.lastError).toBeUndefined();
  expect(manager.getTimeline(snapshot.id)).toContainEqual(
    expect.objectContaining({
      type: "assistant_message",
      text: expect.stringContaining("Cannot launch a new turn"),
    }),
  );

  await manager.closeAgent(snapshot.id);
  rmSync(workdir, { recursive: true, force: true });
});

test("a turn that ran and failed still reports agent health as error", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-real-failure-"));
  const client = new BusyRejectingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000002890",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  // A turn the provider accepted and then failed is a genuine agent failure.
  client.session!.pushEvent({ type: "turn_started", provider: "codex", turnId: "turn-live" });
  client.session!.pushEvent({
    type: "turn_failed",
    provider: "codex",
    turnId: "turn-live",
    error: "provider crashed mid-turn",
  });

  await vi.waitFor(() => {
    const failed = manager.getAgent(snapshot.id);
    expect(failed?.lifecycle).toBe("error");
    expect(failed?.lastError).toBe("provider crashed mid-turn");
  });

  await manager.closeAgent(snapshot.id);
  rmSync(workdir, { recursive: true, force: true });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { toAgentPayload } from "./agent-projections.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ProviderCatalog,
} from "./agent-sdk-types.js";

/**
 * Contract for the live per-turn progress field (`activeTurnOutputTokens`).
 *
 * These assert the CLEAR at every turn boundary, one test per site. The projection guard in
 * `toAgentPayload` suppresses the symptom of a missed clear in production, so these tests are
 * the only signal that a boundary stopped clearing. Do not collapse them as redundant — each
 * one covers a different method, and they are independent of each other.
 */

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

class TestAgentSession implements AgentSession {
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = "codex-session-1";
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(_prompt: AgentPromptInput, _options?: AgentRunOptions) {
    return { turnId: `turn-${++this.turnIdCounter}` };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: "codex" as const,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
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

  describePersistence(): AgentPersistenceHandle {
    return { provider: "codex", sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class TestAgentClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  session: TestAgentSession | null = null;

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.session = new TestAgentSession(config);
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("not used");
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    return { models: [], modes: [] };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface Harness {
  manager: AgentManager;
  session: TestAgentSession;
  agentId: string;
  cleanup: () => void;
}

async function createHarness(): Promise<Harness> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-turn-progress-"));
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: { codex: client },
    idFactory: () => AGENT_ID,
    logger: createTestLogger(),
  });

  await manager.createAgent({ provider: "codex", cwd: workdir }, AGENT_ID, {
    workspaceId: undefined,
  });

  const session = client.session;
  if (!session) {
    throw new Error("expected the test client to have created a session");
  }

  return {
    manager,
    session,
    agentId: AGENT_ID,
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

async function drainEventQueue(): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    await Promise.resolve();
  }
}

function readProgress(harness: Harness): {
  activeTurnOutputTokens: number | undefined;
} {
  const agent = harness.manager.getAgent(harness.agentId);
  if (!agent) {
    throw new Error(`agent ${harness.agentId} is gone`);
  }
  // Read the managed agent rather than the payload: the payload's lifecycle guard would hide
  // an uncleared value, which is exactly what these tests exist to catch.
  return { activeTurnOutputTokens: agent.activeTurnOutputTokens };
}

function usageUpdated(turnId: string, activeTurnOutputTokens: number): AgentStreamEvent {
  return {
    type: "usage_updated",
    provider: "codex",
    usage: { inputTokens: 10, outputTokens: 20 },
    turnId,
    activeTurnOutputTokens,
  };
}

/** Put the agent into a running autonomous turn that has reported a token count. */
async function startAutonomousTurnWithProgress(
  harness: Harness,
  turnId: string,
  tokens = 1234,
): Promise<void> {
  harness.session.pushEvent({ type: "turn_started", provider: "codex", turnId });
  await drainEventQueue();
  harness.session.pushEvent(usageUpdated(turnId, tokens));
  await drainEventQueue();
  expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: tokens });
}

describe("live turn progress", () => {
  test("records the running turn's token count and turn id from usage_updated", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1", 512);

      const agent = harness.manager.getAgent(harness.agentId);
      if (!agent) throw new Error("agent is gone");
      const payload = toAgentPayload(agent);
      expect(payload.activeTurnOutputTokens).toBe(512);
      expect(payload.activeTurn?.turnId).toBe("autonomous-1");
      expect(payload.activeTurnIdleMs).toBeGreaterThanOrEqual(0);
    } finally {
      harness.cleanup();
    }
  });

  test("clears the count when a provider stops reporting mid-turn", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1", 512);

      // A usage event with no count must make the slot disappear rather than freeze it on a
      // stale value — a frozen counter reads as "the model is stuck", which it is not.
      harness.session.pushEvent({
        type: "usage_updated",
        provider: "codex",
        usage: { inputTokens: 10, outputTokens: 20 },
        turnId: "autonomous-1",
      });
      await drainEventQueue();

      expect(readProgress(harness).activeTurnOutputTokens).toBeUndefined();
    } finally {
      harness.cleanup();
    }
  });

  test("a metadata write bumps updatedAt without resetting the stall clock", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1", 512);
      const agent = harness.manager.getAgent(harness.agentId);
      if (!agent) throw new Error("agent is gone");

      const streamActivityAtMs = agent.lastStreamActivityAt?.getTime();
      expect(streamActivityAtMs).toBeTypeOf("number");
      const updatedAtBefore = agent.updatedAt.getTime();

      // Labels stand in for every non-stream `touchUpdatedAt` caller — renames, mode changes,
      // and the background title generation that lands on any silent agent. If idleness tracked
      // `updatedAt`, any one of them would silently reset a genuine stall.
      await harness.manager.setLabels(harness.agentId, { pinned: "true" });

      // `getAgent` hands back a shallow copy, so re-read rather than reusing the snapshot above.
      const after = harness.manager.getAgent(harness.agentId);
      if (!after) throw new Error("agent is gone");
      expect(after.updatedAt.getTime()).toBeGreaterThan(updatedAtBefore);
      expect(after.lastStreamActivityAt?.getTime()).toBe(streamActivityAtMs);
    } finally {
      harness.cleanup();
    }
  });
});

describe("live turn progress is cleared at every turn boundary", () => {
  test("clear site 1: a foreground turn start", async () => {
    const harness = await createHarness();
    try {
      // Simulate a count that leaked past a terminal path. Every terminal site clears, so the
      // only way to reach this state is a bug — which is precisely what this site guards.
      const agent = harness.manager.getAgent(harness.agentId);
      if (!agent) throw new Error("agent is gone");
      agent.activeTurnOutputTokens = 999;

      const stream = harness.manager.streamAgent(harness.agentId, "hello");
      const first = stream.next();
      await drainEventQueue();

      expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: undefined });

      harness.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "turn-1" });
      await drainEventQueue();
      await first;
      await stream.return(undefined);
    } finally {
      harness.cleanup();
    }
  });

  test("clear site 2: an autonomous turn start", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1");

      harness.session.pushEvent({
        type: "turn_started",
        provider: "codex",
        turnId: "autonomous-2",
      });
      await drainEventQueue();

      expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: undefined });
    } finally {
      harness.cleanup();
    }
  });

  test("clear site 3: turn_completed", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1");

      // Deliberately no usage on the completion event: Claude's autonomous completion path
      // omits it, so a usage-driven clear would leak the count into the next turn.
      harness.session.pushEvent({
        type: "turn_completed",
        provider: "codex",
        turnId: "autonomous-1",
      });
      await drainEventQueue();

      expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: undefined });
    } finally {
      harness.cleanup();
    }
  });

  test("clear site 4: turn_failed", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1");

      harness.session.pushEvent({
        type: "turn_failed",
        provider: "codex",
        error: "boom",
        turnId: "autonomous-1",
      });
      await drainEventQueue();

      expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: undefined });
    } finally {
      harness.cleanup();
    }
  });

  test("clear site 5: turn_canceled", async () => {
    const harness = await createHarness();
    try {
      await startAutonomousTurnWithProgress(harness, "autonomous-1");

      harness.session.pushEvent({
        type: "turn_canceled",
        provider: "codex",
        turnId: "autonomous-1",
      });
      await drainEventQueue();

      expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: undefined });
    } finally {
      harness.cleanup();
    }
  });

  test("clear site 6: finalizing a foreground turn", async () => {
    const harness = await createHarness();
    try {
      const stream = harness.manager.streamAgent(harness.agentId, "hello");
      const first = stream.next();
      await drainEventQueue();

      harness.session.pushEvent(usageUpdated("turn-1", 777));
      await drainEventQueue();
      expect(readProgress(harness).activeTurnOutputTokens).toBe(777);

      // A foreground terminal event routes through finalizeForegroundTurn, which owns the
      // clear for this path.
      harness.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "turn-1" });
      await drainEventQueue();
      await first;
      await stream.return(undefined);

      expect(readProgress(harness)).toEqual({ activeTurnOutputTokens: undefined });
    } finally {
      harness.cleanup();
    }
  });

  test("every progress change strictly advances updatedAt", async () => {
    const harness = await createHarness();
    try {
      const stream = harness.manager.streamAgent(harness.agentId, "hello");
      const first = stream.next();
      await drainEventQueue();

      const beforeCount = harness.manager.getAgent(harness.agentId);
      if (!beforeCount) throw new Error("agent is gone");
      const beforeCountMs = beforeCount.updatedAt.getTime();

      harness.session.pushEvent(usageUpdated("turn-1", 777));
      await drainEventQueue();

      const counted = harness.manager.getAgent(harness.agentId);
      if (!counted) throw new Error("agent is gone");
      expect(counted.activeTurnOutputTokens).toBe(777);
      // The client orders directory updates by `updatedAt` and takes the incoming record on a
      // tie. Two snapshots that disagree about progress at one timestamp would let whichever
      // arrives last win, so a delayed record could put a dead count back on screen.
      expect(counted.updatedAt.getTime()).toBeGreaterThan(beforeCountMs);

      harness.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "turn-1" });
      await drainEventQueue();
      await first;
      await stream.return(undefined);

      const cleared = harness.manager.getAgent(harness.agentId);
      if (!cleared) throw new Error("agent is gone");
      expect(cleared.activeTurnOutputTokens).toBeUndefined();
      expect(cleared.updatedAt.getTime()).toBeGreaterThan(counted.updatedAt.getTime());
    } finally {
      harness.cleanup();
    }
  });
});

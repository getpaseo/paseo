import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { CoordinatorResumeStore } from "./coordinator-resume-store.js";
import { CoordinatorResumeWorker } from "./coordinator-resume-worker.js";

const roots: string[] = [];

async function* startTurnWithHook(
  lifecycleHooks: { onTurnStarted(turnId: string): Promise<void> },
  turnId: string,
): AsyncGenerator<AgentStreamEvent> {
  await lifecycleHooks.onTurnStarted(turnId);
  yield* [];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function storedAgent(input: {
  id: string;
  provider: "codex" | "claude";
  labels?: Record<string, string>;
  archivedAt?: string;
}): StoredAgentRecord {
  return {
    id: input.id,
    provider: input.provider,
    cwd: "/tmp/coordinator-resume-test",
    workspaceId: "workspace-1",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    labels: input.labels ?? {},
    lastStatus: "closed",
    persistence: { provider: input.provider, sessionId: `${input.id}-session` },
    ...(input.archivedAt ? { archivedAt: input.archivedAt } : {}),
  };
}

function liveCoordinator(): ManagedAgent {
  return {
    id: "coordinator-1",
    provider: "codex",
    cwd: "/tmp/coordinator-resume-test",
    workspaceId: "workspace-1",
    createdAt: new Date("2026-07-28T12:00:00.000Z"),
    updatedAt: new Date("2026-07-28T12:00:00.000Z"),
    lifecycle: "idle",
    runtimeInfo: null,
    persistence: { provider: "codex", sessionId: "coordinator-1-session" },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    activeForegroundTurnId: null,
    pendingReplacement: false,
    labels: {},
    features: [],
    lastUsage: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    lastUserMessageAt: null,
  } as unknown as ManagedAgent;
}

async function createPendingStore(options?: { now?: () => Date }): Promise<CoordinatorResumeStore> {
  const root = await mkdtemp(join(tmpdir(), "coordinator-resume-worker-"));
  roots.push(root);
  const store = new CoordinatorResumeStore(join(root, "outbox.json"), options);
  const armed = await store.arm({
    childAgentId: "child-1",
    coordinatorAgentId: "coordinator-1",
  });
  await store.bindChildTurn(armed.eventId, "child-turn-1");
  await store.promoteChild({
    childAgentId: "child-1",
    childTurnId: "child-turn-1",
    outcome: "completed",
    currentParentAgentId: "coordinator-1",
  });
  return store;
}

describe("CoordinatorResumeWorker", () => {
  test("resumes a closed Codex coordinator, starts an explicit turn, and acks that turn", async () => {
    const store = await createPendingStore();
    const records = new Map<string, StoredAgentRecord>([
      [
        "child-1",
        storedAgent({
          id: "child-1",
          provider: "claude",
          labels: { [PARENT_AGENT_ID_LABEL]: "coordinator-1" },
        }),
      ],
      ["coordinator-1", storedAgent({ id: "coordinator-1", provider: "codex" })],
    ]);
    const storage = {
      get: vi.fn(async (agentId: string) => records.get(agentId) ?? null),
    } as unknown as AgentStorage;
    let live: ManagedAgent | null = null;
    let deliveredPrompt: unknown = null;
    const resumeAgentFromPersistence = vi.fn(async () => {
      live = liveCoordinator();
      return live;
    });
    const manager = {
      getRegisteredProviderIds: () => ["codex", "claude"],
      getAgent: () => live,
      touchAgentActivity: () => live,
      waitForAgentClose: async () => undefined,
      resumeAgentFromPersistence,
      createAgent: vi.fn(),
      hydrateTimelineFromProvider: vi.fn(),
      tryRunOutOfBand: () => false,
      hasInFlightRun: () => false,
      streamAgent: (
        _agentId: string,
        prompt: unknown,
        _runOptions: unknown,
        lifecycleHooks: { onTurnStarted(turnId: string): Promise<void> },
      ) => {
        deliveredPrompt = prompt;
        return startTurnWithHook(lifecycleHooks, "coordinator-turn-1");
      },
    } as unknown as AgentManager;
    const worker = new CoordinatorResumeWorker(store, manager, storage, createTestLogger());

    await worker.start();
    try {
      await vi.waitFor(
        async () => {
          expect((await store.list())[0]).toMatchObject({
            state: "delivered",
            coordinatorTurnId: "coordinator-turn-1",
          });
        },
        { timeout: 10_000 },
      );
      expect(resumeAgentFromPersistence).toHaveBeenCalledOnce();
      expect(deliveredPrompt).toContain("Coordinator resume event:");
      expect(deliveredPrompt).toContain("Inspect the child timeline");

      await worker.handleTurnTerminal({
        agentId: "coordinator-1",
        turnId: "coordinator-turn-1",
        outcome: "completed",
      });
      expect((await store.list())[0]?.state).toBe("acked");
    } finally {
      await worker.stop();
    }
  });

  test("does not replace an unrelated active coordinator turn", async () => {
    const store = await createPendingStore();
    const records = new Map<string, StoredAgentRecord>([
      [
        "child-1",
        storedAgent({
          id: "child-1",
          provider: "claude",
          labels: { [PARENT_AGENT_ID_LABEL]: "coordinator-1" },
        }),
      ],
      ["coordinator-1", storedAgent({ id: "coordinator-1", provider: "codex" })],
    ]);
    const storage = {
      get: vi.fn(async (agentId: string) => records.get(agentId) ?? null),
    } as unknown as AgentStorage;
    const streamAgent = vi.fn();
    const manager = {
      getRegisteredProviderIds: () => ["codex"],
      hasInFlightRun: () => true,
      streamAgent,
    } as unknown as AgentManager;
    const worker = new CoordinatorResumeWorker(store, manager, storage, createTestLogger());

    await worker.start();
    try {
      await vi.waitFor(
        async () => {
          expect((await store.list())[0]).toMatchObject({ state: "pending", attempt: 1 });
        },
        { timeout: 10_000 },
      );
      expect(streamAgent).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });

  test("retries failed and canceled delivery turns and only acks the exact completion", async () => {
    let nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    const store = await createPendingStore({ now: () => new Date(nowMs) });
    const storage = {
      get: vi.fn(async (agentId: string) =>
        agentId === "coordinator-1"
          ? storedAgent({ id: "coordinator-1", provider: "codex" })
          : null,
      ),
    } as unknown as AgentStorage;
    const worker = new CoordinatorResumeWorker(
      store,
      {} as AgentManager,
      storage,
      createTestLogger(),
    );
    const firstLease = await store.leaseNext({ leaseMs: 1_000 });
    expect(firstLease).not.toBeNull();
    await store.markDelivered({
      eventId: firstLease!.eventId,
      leaseId: firstLease!.leaseId!,
      coordinatorTurnId: "coordinator-turn-1",
    });

    await worker.handleTurnTerminal({
      agentId: "coordinator-1",
      turnId: "coordinator-turn-1",
      outcome: "failed",
    });
    expect((await store.list())[0]).toMatchObject({ state: "pending", attempt: 1 });

    nowMs += 1_000;
    const secondLease = await store.leaseNext({ leaseMs: 1_000 });
    expect(secondLease).not.toBeNull();
    await store.markDelivered({
      eventId: secondLease!.eventId,
      leaseId: secondLease!.leaseId!,
      coordinatorTurnId: "coordinator-turn-2",
    });
    await worker.handleTurnTerminal({
      agentId: "coordinator-1",
      turnId: "coordinator-turn-2",
      outcome: "canceled",
    });
    expect((await store.list())[0]).toMatchObject({ state: "pending", attempt: 2 });

    nowMs += 2_000;
    const thirdLease = await store.leaseNext({ leaseMs: 1_000 });
    expect(thirdLease).not.toBeNull();
    await store.markDelivered({
      eventId: thirdLease!.eventId,
      leaseId: thirdLease!.leaseId!,
      coordinatorTurnId: "coordinator-turn-3",
    });
    await worker.handleTurnTerminal({
      agentId: "coordinator-1",
      turnId: "unrelated-turn",
      outcome: "completed",
    });
    expect((await store.list())[0]?.state).toBe("delivered");

    await worker.handleTurnTerminal({
      agentId: "coordinator-1",
      turnId: "coordinator-turn-3",
      outcome: "completed",
    });
    expect((await store.list())[0]?.state).toBe("acked");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
} from "../agent-sdk-types.js";
import { AgentStorage } from "../agent-storage.js";
import { FakeRewindSession, REWIND_TEST_CAPABILITIES } from "./test-rewind-session.js";

class FakeRewindClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = REWIND_TEST_CAPABILITIES;

  constructor(readonly session: FakeRewindSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    return this.session;
  }

  async fetchCatalog(_options: FetchCatalogOptions) {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

class RewindHistoryGate {
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
    this.gate = null;
  }

  async wait(): Promise<void> {
    await this.gate;
  }
}

async function createRewindHarness(
  options: {
    historyGate?: RewindHistoryGate;
    session?: FakeRewindSession;
    storage?: AgentStorage;
  } = {},
) {
  const session =
    options.session ?? new FakeRewindSession(options.historyGate?.wait.bind(options.historyGate));
  const manager = new AgentManager({
    clients: { claude: new FakeRewindClient(session) },
    registry: options.storage,
    logger: createTestLogger(),
    idFactory: () => "00000000-0000-4000-8000-000000000901",
  });
  const agent = await manager.createAgent(
    {
      provider: "claude",
      cwd: process.cwd(),
    },
    undefined,
    { workspaceId: undefined },
  );
  return { manager, session, agentId: agent.id };
}

async function createPersistedRewindHarness(session = new FakeRewindSession()) {
  const root = mkdtempSync(join(tmpdir(), "material-progress-rewind-"));
  const storage = new AgentStorage(join(root, "agents"), createTestLogger());
  const harness = await createRewindHarness({ session, storage });
  return {
    ...harness,
    storage,
    async cleanup() {
      await harness.manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function seedMaterialProgress(
  manager: AgentManager,
  session: FakeRewindSession,
  agentId: string,
): Promise<void> {
  const run = manager.streamAgent(agentId, "produce durable progress");
  await run.next();
  await manager.appendTimelineItem(agentId, {
    type: "tool_call",
    callId: "write-before-rewind",
    name: "write",
    status: "completed",
    error: null,
    detail: { type: "write", filePath: "proof.txt", content: "durable proof" },
  });
  await session.interrupt();
  for await (const _event of run) {
    // Drain the canceled turn so its terminal state is persisted.
  }
  await manager.flush();
  expect(manager.getMaterialProgress(agentId)).toMatchObject({
    state: "progressing",
    lastMaterialProgressKind: "write",
  });
}

describe("AgentManager rewind", () => {
  test("rewinds the conversation and rehydrates the timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "conversation");

    expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(1);
    expect(manager.fetchTimeline(agentId, { limit: 0 }).rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "before", messageId: "message-1" },
    ]);
  });

  test("rewinds files without rehydrating the conversation timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(0);
  });

  test("invalidates and persists material progress after a successful files rewind", async () => {
    const { manager, session, storage, agentId, cleanup } = await createPersistedRewindHarness();

    try {
      await seedMaterialProgress(manager, session, agentId);

      await manager.rewind(agentId, "message-1", "files");

      expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
      expect(session.historyReadCount).toBe(0);
      expect(manager.getMaterialProgress(agentId)).toMatchObject({
        state: "none",
        continuationBoundarySeq: null,
        lastMaterialProgressKind: null,
        reason: "Material progress is unavailable because the provider session was rewound.",
      });
      expect((await storage.get(agentId))?.materialProgress).toMatchObject({
        continuationBoundarySeq: null,
        lastMaterialProgressKind: null,
        unavailableReason:
          "Material progress is unavailable because the provider session was rewound.",
      });
    } finally {
      await cleanup();
    }
  });

  test("persists invalidation before conversation history rehydration can fail", async () => {
    class FailingHistorySession extends FakeRewindSession {
      override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield* super.streamHistory();
        throw new Error("history unavailable after successful rewind");
      }
    }

    const session = new FailingHistorySession();
    const { manager, storage, agentId, cleanup } = await createPersistedRewindHarness(session);

    try {
      await seedMaterialProgress(manager, session, agentId);

      await expect(manager.rewind(agentId, "message-1", "conversation")).rejects.toThrow(
        "history unavailable after successful rewind",
      );

      expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "message-1" }]);
      expect(session.historyReadCount).toBe(1);
      expect(manager.getMaterialProgress(agentId)).toMatchObject({
        state: "none",
        continuationBoundarySeq: null,
        lastMaterialProgressKind: null,
        reason: "Material progress is unavailable because the provider session was rewound.",
      });
      expect((await storage.get(agentId))?.materialProgress).toMatchObject({
        continuationBoundarySeq: null,
        lastMaterialProgressKind: null,
        unavailableReason:
          "Material progress is unavailable because the provider session was rewound.",
      });
    } finally {
      await cleanup();
    }
  });

  test("preserves material progress when the provider rewind fails", async () => {
    class RejectingProviderRewindSession extends FakeRewindSession {
      override async revertFiles(): Promise<void> {
        throw new Error("provider rewind rejected");
      }
    }

    const session = new RejectingProviderRewindSession();
    const { manager, storage, agentId, cleanup } = await createPersistedRewindHarness(session);

    try {
      await seedMaterialProgress(manager, session, agentId);
      const beforePayload = manager.getMaterialProgress(agentId);
      const beforeStored = structuredClone((await storage.get(agentId))?.materialProgress);

      await expect(manager.rewind(agentId, "message-1", "files")).rejects.toThrow(
        "provider rewind rejected",
      );

      expect(session.recordedRewinds).toEqual([]);
      expect(manager.getMaterialProgress(agentId)).toEqual(beforePayload);
      expect((await storage.get(agentId))?.materialProgress).toEqual(beforeStored);
    } finally {
      await cleanup();
    }
  });

  test("aborts an in-flight turn before rewinding", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const run = manager.streamAgent(agentId, "keep working");
    await run.next();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.aborted).toBe(true);
    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
  });

  test("does not rewind when the in-flight turn rejects cancellation", async () => {
    class RejectingInterruptSession extends FakeRewindSession {
      override async interrupt(): Promise<void> {
        throw new Error("provider still owns the active turn");
      }
    }

    const session = new RejectingInterruptSession();
    const manager = new AgentManager({
      clients: { claude: new FakeRewindClient(session) },
      logger: createTestLogger(),
      idFactory: () => "00000000-0000-4000-8000-000000000902",
    });
    const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
      workspaceId: undefined,
    });
    const run = manager.streamAgent(agent.id, "keep working");
    await run.next();

    await expect(manager.rewind(agent.id, "message-1", "files")).rejects.toThrow(
      `Cannot rewind agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
    expect(session.recordedRewinds).toEqual([]);
    expect(manager.getAgent(agent.id)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: "turn-1",
    });
  });

  test("blocks new prompts until the rehydrate epoch broadcasts", async () => {
    const historyGate = new RewindHistoryGate();
    historyGate.hold();
    const { manager, agentId } = await createRewindHarness({ historyGate });

    const rewind = manager.rewind(agentId, "message-1", "both");

    expect(() => manager.streamAgent(agentId, "too early")).toThrow(
      "Agent 00000000-0000-4000-8000-000000000901 already has an active run",
    );

    historyGate.release();
    await rewind;
  });
});

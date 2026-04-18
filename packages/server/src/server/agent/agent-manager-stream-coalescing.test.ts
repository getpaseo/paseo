import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "./agent-sdk-types.js";

/**
 * Contract for AgentManager pre-record stream coalescing.
 * Assistant/reasoning chunks coalesce before recordTimeline() assigns canonical seqs.
 */

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const AGENT_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
] as const;

const TOOL_CALL: AgentTimelineItem = {
  type: "tool_call",
  callId: "tool-1",
  name: "shell",
  status: "completed",
  error: null,
  detail: {
    type: "shell",
    command: "printf ok",
    output: "ok",
    exitCode: 0,
  },
};

class TestAgentSession implements AgentSession {
  readonly capabilities = TEST_CAPABILITIES;
  readonly id: string;
  private historyEvents: AgentStreamEvent[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;

  constructor(
    readonly provider: AgentProvider,
    private readonly config: AgentSessionConfig,
    sessionId: string,
  ) {
    this.id = sessionId;
  }

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
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

  setHistory(events: AgentStreamEvent[]): void {
    this.historyEvents = [...events];
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.historyEvents) {
      yield event;
    }
  }

  async getRuntimeInfo() {
    return {
      provider: this.provider,
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
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class TestAgentClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  private sessionCounter = 0;
  readonly sessions = new Map<string, TestAgentSession>();

  constructor(readonly provider: AgentProvider = "codex") {}

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new TestAgentSession(
      config.provider,
      config,
      `${config.provider}-session-${++this.sessionCounter}`,
    );
    this.sessions.set(config.cwd, session);
    return session;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const resolvedConfig: AgentSessionConfig = {
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
      ...config,
    };
    return this.createSession(resolvedConfig);
  }

  async listModels(): Promise<AgentModelDefinition[]> {
    return [
      {
        provider: this.provider,
        id: "test-model",
        label: "Test Model",
        isDefault: true,
      },
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getSession(cwd: string): TestAgentSession {
    const session = this.sessions.get(cwd);
    if (!session) {
      throw new Error(`No test session for cwd ${cwd}`);
    }
    return session;
  }
}

type Harness = {
  manager: AgentManager;
  client: TestAgentClient;
  events: AgentManagerEvent[];
  workdir: string;
  cleanup: () => void;
};

function createHarness(options?: { provider?: AgentProvider }): Harness {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-stream-coalescing-"));
  const client = new TestAgentClient(options?.provider ?? "codex");
  const manager = new AgentManager({
    clients: { [client.provider]: client },
    idFactory: createIdFactory(),
    logger: createTestLogger(),
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { replayState: false });

  return {
    manager,
    client,
    events,
    workdir,
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

function createIdFactory(): () => string {
  let index = 0;
  return () => AGENT_IDS[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function createManagedSession(
  harness: Harness,
  options?: { agentId?: string; provider?: AgentProvider; workdir?: string },
): Promise<{ agentId: string; session: TestAgentSession; workdir: string }> {
  const agentId = options?.agentId ?? AGENT_IDS[0];
  const workdir = options?.workdir ?? harness.workdir;
  await harness.manager.createAgent(
    {
      provider: options?.provider ?? harness.client.provider,
      cwd: workdir,
    },
    agentId,
  );
  return {
    agentId,
    session: harness.client.getSession(workdir),
    workdir,
  };
}

function assistant(
  text: string,
  provider: AgentProvider = "codex",
  turnId?: string,
): AgentStreamEvent {
  return {
    type: "timeline",
    provider,
    turnId,
    item: { type: "assistant_message", text },
  };
}

function reasoning(
  text: string,
  provider: AgentProvider = "codex",
  turnId?: string,
): AgentStreamEvent {
  return {
    type: "timeline",
    provider,
    turnId,
    item: { type: "reasoning", text },
  };
}

function timelineEvent(
  item: AgentTimelineItem,
  provider: AgentProvider = "codex",
  turnId?: string,
): AgentStreamEvent {
  return {
    type: "timeline",
    provider,
    turnId,
    item,
  };
}

function terminalEvent(
  type: "turn_completed" | "turn_failed" | "turn_canceled",
  turnId: string,
): AgentStreamEvent {
  if (type === "turn_completed") {
    return { type, provider: "codex", turnId };
  }
  if (type === "turn_failed") {
    return { type, provider: "codex", turnId, error: "failed" };
  }
  return { type, provider: "codex", turnId, reason: "canceled" };
}

function getStreamEvents(events: AgentManagerEvent[], agentId: string): AgentManagerEvent[] {
  return events.filter((event) => event.type === "agent_stream" && event.agentId === agentId);
}

function getTimelineStreamEvents(
  events: AgentManagerEvent[],
  agentId: string,
): AgentManagerEvent[] {
  return getStreamEvents(events, agentId).filter(
    (event) => event.type === "agent_stream" && event.event.type === "timeline",
  );
}

function getTimelineItems(rows: AgentTimelineRow[]): AgentTimelineItem[] {
  return rows.map((row) => row.item);
}

function expectContiguousRowSeqs(rows: AgentTimelineRow[], expected: number[]): void {
  expect(rows.map((row) => row.seq)).toEqual(expected);
}

function expectContiguousLiveSeqs(events: AgentManagerEvent[], expected: number[]): void {
  expect(events.map((event) => (event.type === "agent_stream" ? event.seq : undefined))).toEqual(
    expected,
  );
}

async function waitForSessionEventQueue(): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("target coalesced behavior", () => {
  test("coalesces a same-tick assistant burst after the 33ms window", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      for (let i = 0; i < 1000; i++) {
        session.pushEvent(assistant("x"));
      }
      await waitForSessionEventQueue();

      await vi.advanceTimersByTimeAsync(32);
      expect(await harness.manager.getTimelineRows(agentId)).toHaveLength(0);
      expect(getTimelineStreamEvents(harness.events, agentId)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(rows).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(rows[0]?.item).toEqual({
        type: "assistant_message",
        text: "x".repeat(1000),
      });
      expect(events.map((event) => (event.type === "agent_stream" ? event.event : null))).toEqual([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "x".repeat(1000) },
        },
      ]);
      expectContiguousRowSeqs(rows, [1]);
      expectContiguousLiveSeqs(events, [1]);
    } finally {
      harness.cleanup();
    }
  });

  test("coalesces same-tick reasoning chunks after the 33ms window", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      for (let i = 0; i < 100; i++) {
        session.pushEvent(reasoning("r"));
      }
      await waitForSessionEventQueue();

      await vi.advanceTimersByTimeAsync(33);
      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([{ type: "reasoning", text: "r".repeat(100) }]);
      expect(events).toHaveLength(1);
      expectContiguousRowSeqs(rows, [1]);
      expectContiguousLiveSeqs(events, [1]);
    } finally {
      harness.cleanup();
    }
  });

  test("preserves order when an atomic timeline event lands between two large bursts", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      for (let i = 0; i < 500; i++) {
        session.pushEvent(assistant("a"));
      }
      session.pushEvent(timelineEvent(TOOL_CALL));
      await waitForSessionEventQueue();

      expect(getTimelineItems(await harness.manager.getTimelineRows(agentId))).toEqual([
        { type: "assistant_message", text: "a".repeat(500) },
        TOOL_CALL,
      ]);
      expectContiguousLiveSeqs(getTimelineStreamEvents(harness.events, agentId), [1, 2]);

      for (let i = 0; i < 500; i++) {
        session.pushEvent(assistant("b"));
      }
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(32);
      expect(await harness.manager.getTimelineRows(agentId)).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);
      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "a".repeat(500) },
        TOOL_CALL,
        { type: "assistant_message", text: "b".repeat(500) },
      ]);
      expectContiguousRowSeqs(rows, [1, 2, 3]);
      expectContiguousLiveSeqs(events, [1, 2, 3]);
    } finally {
      harness.cleanup();
    }
  });

  test("preserves assistant and reasoning interleave", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      session.pushEvent(assistant("a1"));
      session.pushEvent(reasoning("r1"));
      session.pushEvent(reasoning("r2"));
      session.pushEvent(assistant("a2"));
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(33);

      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "a1" },
        { type: "reasoning", text: "r1r2" },
        { type: "assistant_message", text: "a2" },
      ]);
      expect(events).toHaveLength(3);
      expectContiguousRowSeqs(rows, [1, 2, 3]);
      expectContiguousLiveSeqs(events, [1, 2, 3]);
    } finally {
      harness.cleanup();
    }
  });

  test("preserves strict alternating assistant/reasoning order", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      for (let i = 1; i <= 5; i++) {
        session.pushEvent(assistant(`a${i}`));
        session.pushEvent(reasoning(`r${i}`));
      }
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(33);

      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "a1" },
        { type: "reasoning", text: "r1" },
        { type: "assistant_message", text: "a2" },
        { type: "reasoning", text: "r2" },
        { type: "assistant_message", text: "a3" },
        { type: "reasoning", text: "r3" },
        { type: "assistant_message", text: "a4" },
        { type: "reasoning", text: "r4" },
        { type: "assistant_message", text: "a5" },
        { type: "reasoning", text: "r5" },
      ]);
      expect(rows).toHaveLength(10);
      expect(events).toHaveLength(10);
      expectContiguousRowSeqs(
        rows,
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
      expectContiguousLiveSeqs(
        events,
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
    } finally {
      harness.cleanup();
    }
  });

  test("isolates buffers per agent", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const first = await createManagedSession(harness, {
        agentId: AGENT_IDS[0],
        workdir: harness.workdir,
      });
      const secondWorkdir = mkdtempSync(join(tmpdir(), "agent-manager-stream-coalescing-"));
      const second = await createManagedSession(harness, {
        agentId: AGENT_IDS[1],
        workdir: secondWorkdir,
      });

      first.session.pushEvent(assistant("a"));
      second.session.pushEvent(assistant("b"));
      first.session.pushEvent(assistant("a"));
      second.session.pushEvent(assistant("b"));
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(33);

      const firstRows = await harness.manager.getTimelineRows(first.agentId);
      const secondRows = await harness.manager.getTimelineRows(second.agentId);
      const firstEvents = getTimelineStreamEvents(harness.events, first.agentId);
      const secondEvents = getTimelineStreamEvents(harness.events, second.agentId);

      expect(getTimelineItems(firstRows)).toEqual([{ type: "assistant_message", text: "aa" }]);
      expect(getTimelineItems(secondRows)).toEqual([{ type: "assistant_message", text: "bb" }]);
      expect(firstEvents).toHaveLength(1);
      expect(secondEvents).toHaveLength(1);
      expectContiguousRowSeqs(firstRows, [1]);
      expectContiguousRowSeqs(secondRows, [1]);
      expectContiguousLiveSeqs(firstEvents, [1]);
      expectContiguousLiveSeqs(secondEvents, [1]);
      rmSync(secondWorkdir, { recursive: true, force: true });
    } finally {
      harness.cleanup();
    }
  });

  test("provider boundaries break collapse", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      session.pushEvent(assistant("codex", "codex"));
      session.pushEvent(assistant("claude", "claude"));
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(33);

      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "codex" },
        { type: "assistant_message", text: "claude" },
      ]);
      expect(events.map((event) => (event.type === "agent_stream" ? event.event : null))).toEqual([
        { type: "timeline", provider: "codex", item: { type: "assistant_message", text: "codex" } },
        {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text: "claude" },
        },
      ]);
      expectContiguousRowSeqs(rows, [1, 2]);
      expectContiguousLiveSeqs(events, [1, 2]);
    } finally {
      harness.cleanup();
    }
  });

  test("turnId boundaries break collapse", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      session.pushEvent(assistant("one", "codex", "turn-1"));
      session.pushEvent(assistant("two", "codex", "turn-2"));
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(33);

      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "one" },
        { type: "assistant_message", text: "two" },
      ]);
      expect(events.map((event) => (event.type === "agent_stream" ? event.event : null))).toEqual([
        {
          type: "timeline",
          provider: "codex",
          turnId: "turn-1",
          item: { type: "assistant_message", text: "one" },
        },
        {
          type: "timeline",
          provider: "codex",
          turnId: "turn-2",
          item: { type: "assistant_message", text: "two" },
        },
      ]);
      expectContiguousRowSeqs(rows, [1, 2]);
      expectContiguousLiveSeqs(events, [1, 2]);
    } finally {
      harness.cleanup();
    }
  });

  test("drops empty text but preserves whitespace byte-exactly", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      session.pushEvent(assistant(""));
      session.pushEvent(assistant(" "));
      session.pushEvent(assistant("\n\t"));
      session.pushEvent(assistant("done"));
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(33);

      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([{ type: "assistant_message", text: " \n\tdone" }]);
      expect(events).toHaveLength(1);
      expectContiguousRowSeqs(rows, [1]);
      expectContiguousLiveSeqs(events, [1]);
    } finally {
      harness.cleanup();
    }
  });

  test("flushes pending chunks before terminal lifecycle events by dispatch order", async () => {
    vi.useFakeTimers();

    for (const terminalType of ["turn_completed", "turn_failed", "turn_canceled"] as const) {
      const harness = createHarness();
      try {
        const { agentId, session } = await createManagedSession(harness);

        session.pushEvent(assistant(`${terminalType}-text`, "codex", terminalType));
        session.pushEvent(terminalEvent(terminalType, terminalType));
        await waitForSessionEventQueue();

        const streamEvents = getStreamEvents(harness.events, agentId);
        const timelineEvents = getTimelineStreamEvents(harness.events, agentId);
        const rows = await harness.manager.getTimelineRows(agentId);

        expect(getTimelineItems(rows)[0]).toEqual({
          type: "assistant_message",
          text: `${terminalType}-text`,
        });
        const expectedTimelineEventCount = terminalType === "turn_failed" ? 2 : 1;
        expect(timelineEvents).toHaveLength(expectedTimelineEventCount);
        expect(streamEvents[0]).toMatchObject({
          type: "agent_stream",
          event: {
            type: "timeline",
            item: { type: "assistant_message", text: `${terminalType}-text` },
          },
          seq: 1,
        });
        const terminalEventIndex = streamEvents.findIndex(
          (event) => event.type === "agent_stream" && event.event.type === terminalType,
        );
        expect(terminalEventIndex).toBeGreaterThan(0);
        expect(streamEvents[terminalEventIndex]).toMatchObject({
          type: "agent_stream",
          event: { type: terminalType },
        });
        expect(
          streamEvents[terminalEventIndex]?.type === "agent_stream"
            ? streamEvents[terminalEventIndex].seq
            : undefined,
        ).toBe(undefined);

        await vi.advanceTimersByTimeAsync(33);
        expect(await harness.manager.getTimelineRows(agentId)).toHaveLength(
          expectedTimelineEventCount,
        );
        expect(getTimelineStreamEvents(harness.events, agentId)).toHaveLength(
          expectedTimelineEventCount,
        );
      } finally {
        harness.cleanup();
      }
    }
  });

  test("lifecycle paths are timer-safe", async () => {
    vi.useFakeTimers();

    const closeHarness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(closeHarness);
      session.pushEvent(assistant("close"));
      await waitForSessionEventQueue();
      await closeHarness.manager.closeAgent(agentId);
      await vi.advanceTimersByTimeAsync(100);

      expect(getTimelineStreamEvents(closeHarness.events, agentId)).toHaveLength(1);
      expect(getTimelineStreamEvents(closeHarness.events, agentId)[0]).toMatchObject({
        type: "agent_stream",
        event: { type: "timeline", item: { type: "assistant_message", text: "close" } },
        seq: 1,
      });
    } finally {
      closeHarness.cleanup();
    }

    const reloadHarness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(reloadHarness);
      session.pushEvent(assistant("reload"));
      await waitForSessionEventQueue();
      await reloadHarness.manager.reloadAgentSession(agentId);
      await vi.advanceTimersByTimeAsync(100);

      const rows = await reloadHarness.manager.getTimelineRows(agentId);
      expect(getTimelineItems(rows)).toEqual([{ type: "assistant_message", text: "reload" }]);
      expect(getTimelineStreamEvents(reloadHarness.events, agentId)).toHaveLength(1);
    } finally {
      reloadHarness.cleanup();
    }

    const deletionHarness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(deletionHarness);
      session.pushEvent(assistant("delete"));
      await waitForSessionEventQueue();
      await deletionHarness.manager.closeAgent(agentId);
      await vi.advanceTimersByTimeAsync(100);

      expect(deletionHarness.manager.getAgent(agentId)).toBeNull();
      expect(getTimelineStreamEvents(deletionHarness.events, agentId)).toHaveLength(1);
    } finally {
      deletionHarness.cleanup();
    }
  });

  test("old timers cannot write into reused agent ids", async () => {
    vi.useFakeTimers();

    const reloadHarness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(reloadHarness);
      session.pushEvent(assistant("before-reload"));
      await waitForSessionEventQueue();
      await reloadHarness.manager.reloadAgentSession(agentId);
      await vi.advanceTimersByTimeAsync(100);

      expect(getTimelineItems(await reloadHarness.manager.getTimelineRows(agentId))).toEqual([
        { type: "assistant_message", text: "before-reload" },
      ]);
      expect(getTimelineStreamEvents(reloadHarness.events, agentId)).toHaveLength(1);
    } finally {
      reloadHarness.cleanup();
    }

    const reuseHarness = createHarness();
    try {
      const first = await createManagedSession(reuseHarness, {
        agentId: AGENT_IDS[0],
        workdir: reuseHarness.workdir,
      });
      first.session.pushEvent(assistant("old"));
      await waitForSessionEventQueue();
      await reuseHarness.manager.closeAgent(first.agentId);

      const nextWorkdir = mkdtempSync(join(tmpdir(), "agent-manager-stream-coalescing-"));
      const second = await createManagedSession(reuseHarness, {
        agentId: AGENT_IDS[0],
        workdir: nextWorkdir,
      });
      second.session.pushEvent(assistant("new"));
      await waitForSessionEventQueue();
      await vi.advanceTimersByTimeAsync(100);

      expect(getTimelineItems(await reuseHarness.manager.getTimelineRows(second.agentId))).toEqual([
        { type: "assistant_message", text: "new" },
      ]);
      expect(getTimelineStreamEvents(reuseHarness.events, first.agentId)).toHaveLength(2);
      expect(
        getTimelineStreamEvents(reuseHarness.events, first.agentId).map((event) =>
          event.type === "agent_stream" && event.event.type === "timeline"
            ? event.event.item
            : null,
        ),
      ).toEqual([
        { type: "assistant_message", text: "old" },
        { type: "assistant_message", text: "new" },
      ]);
      rmSync(nextWorkdir, { recursive: true, force: true });
    } finally {
      reuseHarness.cleanup();
    }
  });

  test("flush helper is idempotent and re-entry safe", async () => {
    vi.useFakeTimers();
    const idempotencyHarness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(idempotencyHarness);

      session.pushEvent(assistant("a"));
      session.pushEvent(assistant("b"));
      session.pushEvent(assistant("c"));
      session.pushEvent(timelineEvent(TOOL_CALL));
      session.pushEvent(timelineEvent(TOOL_CALL));
      await waitForSessionEventQueue();

      const rows = await idempotencyHarness.manager.getTimelineRows(agentId);
      const timelineEvents = getTimelineStreamEvents(idempotencyHarness.events, agentId);

      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "abc" },
        TOOL_CALL,
        TOOL_CALL,
      ]);
      expect(timelineEvents).toHaveLength(3);
      expectContiguousRowSeqs(rows, [1, 2, 3]);
      expectContiguousLiveSeqs(timelineEvents, [1, 2, 3]);
    } finally {
      idempotencyHarness.cleanup();
    }

    const reentryHarness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(reentryHarness);
      let didPushDuringFlush = false;
      reentryHarness.manager.subscribe(
        (event) => {
          if (
            didPushDuringFlush ||
            event.type !== "agent_stream" ||
            event.agentId !== agentId ||
            event.event.type !== "timeline" ||
            event.event.item.type !== "assistant_message"
          ) {
            return;
          }
          didPushDuringFlush = true;
          session.pushEvent(assistant("B"));
        },
        { replayState: false },
      );

      session.pushEvent(assistant("A"));
      await waitForSessionEventQueue();

      await vi.advanceTimersByTimeAsync(33);
      await waitForSessionEventQueue();

      const rowsAfterFirstFlush = await reentryHarness.manager.getTimelineRows(agentId);
      expect(getTimelineItems(rowsAfterFirstFlush)).toEqual([
        { type: "assistant_message", text: "A" },
      ]);
      expect(getTimelineStreamEvents(reentryHarness.events, agentId)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(33);
      await waitForSessionEventQueue();

      const rowsAfterSecondFlush = await reentryHarness.manager.getTimelineRows(agentId);
      const timelineEvents = getTimelineStreamEvents(reentryHarness.events, agentId);
      expect(getTimelineItems(rowsAfterSecondFlush)).toEqual([
        { type: "assistant_message", text: "A" },
        { type: "assistant_message", text: "B" },
      ]);
      expect(timelineEvents).toHaveLength(2);
      expectContiguousRowSeqs(rowsAfterSecondFlush, [1, 2]);
      expectContiguousLiveSeqs(timelineEvents, [1, 2]);
      expect(didPushDuringFlush).toBe(true);
    } finally {
      reentryHarness.cleanup();
    }
  });

  test("manager flush drains pending chunks before background tasks", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      session.pushEvent(assistant("flush"));
      await waitForSessionEventQueue();

      expect(await harness.manager.getTimelineRows(agentId)).toHaveLength(0);
      await harness.manager.flush();

      const rows = await harness.manager.getTimelineRows(agentId);
      const events = getTimelineStreamEvents(harness.events, agentId);
      expect(getTimelineItems(rows)).toEqual([{ type: "assistant_message", text: "flush" }]);
      expect(events).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(await harness.manager.getTimelineRows(agentId)).toHaveLength(1);
      expect(getTimelineStreamEvents(harness.events, agentId)).toHaveLength(1);
    } finally {
      harness.cleanup();
    }
  });

  test("history hydration is uncoalesced and immediate", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);
      session.setHistory([assistant("a1"), assistant("a2"), reasoning("r1"), reasoning("r2")]);

      await harness.manager.hydrateTimelineFromProvider(agentId);

      const rows = await harness.manager.getTimelineRows(agentId);
      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "a1" },
        { type: "assistant_message", text: "a2" },
        { type: "reasoning", text: "r1" },
        { type: "reasoning", text: "r2" },
      ]);
      expectContiguousRowSeqs(rows, [1, 2, 3, 4]);
      expect(getTimelineStreamEvents(harness.events, agentId)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(100);
      expect(getTimelineItems(await harness.manager.getTimelineRows(agentId))).toEqual([
        { type: "assistant_message", text: "a1" },
        { type: "assistant_message", text: "a2" },
        { type: "reasoning", text: "r1" },
        { type: "reasoning", text: "r2" },
      ]);
    } finally {
      harness.cleanup();
    }
  });

  test("foreground stream yields coalesced timeline events before terminal events", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);
      const stream = harness.manager.streamAgent(agentId, "prompt");
      const firstEvent = stream.next();
      await harness.manager.waitForAgentRunStart(agentId);

      session.pushEvent(assistant("hello ", "codex", "turn-1"));
      session.pushEvent(assistant("world", "codex", "turn-1"));
      session.pushEvent(terminalEvent("turn_completed", "turn-1"));
      await waitForSessionEventQueue();

      await expect(firstEvent).resolves.toEqual({
        done: false,
        value: {
          type: "timeline",
          provider: "codex",
          turnId: "turn-1",
          item: { type: "assistant_message", text: "hello world" },
        },
      });
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
      });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });

      const rows = await harness.manager.getTimelineRows(agentId);
      const streamEvents = getStreamEvents(harness.events, agentId);
      expect(getTimelineItems(rows)).toEqual([{ type: "assistant_message", text: "hello world" }]);
      expect(streamEvents[0]).toMatchObject({
        type: "agent_stream",
        event: {
          type: "timeline",
          item: { type: "assistant_message", text: "hello world" },
        },
      });
      expect(streamEvents[1]).toMatchObject({
        type: "agent_stream",
        event: { type: "turn_completed" },
      });
    } finally {
      harness.cleanup();
    }
  });

  test("every collapsed item is one timeline row with monotonic seqs", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const { agentId, session } = await createManagedSession(harness);

      session.pushEvent(assistant("a1", "codex", "turn-1"));
      session.pushEvent(assistant("a2", "codex", "turn-1"));
      session.pushEvent(reasoning("r1", "codex", "turn-1"));
      session.pushEvent(reasoning("r2", "codex", "turn-1"));
      session.pushEvent(assistant("b1", "codex", "turn-1"));
      session.pushEvent(assistant("b2", "codex", "turn-1"));
      session.pushEvent(terminalEvent("turn_completed", "turn-1"));
      await waitForSessionEventQueue();

      const rows = await harness.manager.getTimelineRows(agentId);
      expect(getTimelineItems(rows)).toEqual([
        { type: "assistant_message", text: "a1a2" },
        { type: "reasoning", text: "r1r2" },
        { type: "assistant_message", text: "b1b2" },
      ]);
      expectContiguousRowSeqs(rows, [1, 2, 3]);
      const timelineEvents = getTimelineStreamEvents(harness.events, agentId);
      expect(timelineEvents).toHaveLength(3);
      expectContiguousLiveSeqs(timelineEvents, [1, 2, 3]);

      await vi.advanceTimersByTimeAsync(100);
      expect(getTimelineItems(await harness.manager.getTimelineRows(agentId))).toEqual([
        { type: "assistant_message", text: "a1a2" },
        { type: "reasoning", text: "r1r2" },
        { type: "assistant_message", text: "b1b2" },
      ]);
      expect(getTimelineStreamEvents(harness.events, agentId)).toHaveLength(3);
    } finally {
      harness.cleanup();
    }
  });
});

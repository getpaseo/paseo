import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  AgentPurposeSummaryService,
  type AgentPurposeSummaryGenerationRequest,
  type AgentPurposeSummaryOptions,
} from "./agent-purpose-summary.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const BASE_TIME = Date.parse("2026-07-30T12:00:00.000Z");

interface SummaryWrite {
  summary: string;
  expectedPreviousSummary: string | null | undefined;
  summaryCursor?: { epoch: string; seq: number };
  consumedTurns?: number;
}

interface Harness {
  agent: ManagedAgent;
  /** Mirrors AgentManager: bump the persisted counter, then dispatch the event. */
  completeTurn: () => void;
  generationRequests: AgentPurposeSummaryGenerationRequest<unknown>[];
  summaryWrites: SummaryWrite[];
  appendRow: (row: AgentTimelineRow) => void;
  publishState: () => void;
  service: AgentPurposeSummaryService;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentPurposeSummaryService", () => {
  it("generates the first summary after the first completed turn", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      timelineRows: [
        row(1, "2026-07-30T12:00:00.000Z", {
          type: "user_message",
          text: "Add rolling purpose summaries to agents.",
        }),
        row(2, "2026-07-30T12:01:00.000Z", {
          type: "assistant_message",
          text: "I traced the persistence and UI projections.",
        }),
      ],
    });

    harness.completeTurn();
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.generationRequests[0]?.prompt).toContain("Previous summary: (none yet)");
    expect(harness.generationRequests[0]?.prompt).toContain(
      "User: Add rolling purpose summaries to agents.",
    );
    expect(harness.summaryWrites).toEqual([
      {
        summary: "Adds rolling agent summaries and wires their persistence and UI.",
        expectedPreviousSummary: null,
        summaryCursor: { epoch: "epoch-1", seq: 2 },
        consumedTurns: 1,
      },
    ]);
    expect(harness.agent.summaryTurnsSinceUpdate).toBe(0);
    harness.service.dispose();
  });

  it("refreshes once the interval floor passes even without another completed turn", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME),
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
      timelineRows: [
        row(1, "2026-07-30T12:01:00.000Z", {
          type: "user_message",
          text: "Continue after the initial summary.",
        }),
      ],
    });

    harness.completeTurn();
    harness.completeTurn();
    harness.completeTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.generationRequests).toHaveLength(0);

    // No further turns: the armed wake timer is the only thing that can fire.
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.summaryWrites[0]?.expectedPreviousSummary).toBe("Initial purpose.");
    expect(harness.summaryWrites[0]?.consumedTurns).toBe(3);
    expect(harness.agent.summaryTurnsSinceUpdate).toBe(0);
    harness.service.dispose();
  });

  it("does not consume the interval when a completed turn has no conversation transcript", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME - 300_000),
      summaryTurnsSinceUpdate: 3,
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
      timelineRows: [
        row(1, "2026-07-30T12:01:00.000Z", {
          type: "tool_call",
          callId: "call-1",
          name: "status",
          detail: { type: "unknown", input: {}, output: {} },
          status: "completed",
          error: null,
        }),
      ],
    });

    harness.completeTurn();
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(0);

    harness.appendRow(
      row(2, "2026-07-30T12:02:00.000Z", {
        type: "user_message",
        text: "Now summarize the current work.",
      }),
    );
    harness.completeTurn();
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(1);
    harness.service.dispose();
  });

  it("arms a wake timer when an eligible agent is loaded after service startup", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      includeAgentAtStart: false,
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME - 100_000),
      summaryTurnsSinceUpdate: 3,
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
    });

    harness.publishState();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200_000);
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(1);
    harness.service.dispose();
  });

  it("does not apply the interval floor after an empty transcript", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      timelineRows: [],
      minTurnsBetweenGenerations: 1,
      minIntervalMs: 300_000,
    });

    harness.completeTurn();
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(0);

    harness.appendRow(
      row(1, "2026-07-30T12:06:00.000Z", {
        type: "user_message",
        text: "Summarize the now-visible work.",
      }),
    );
    harness.completeTurn();
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(1);
    harness.service.dispose();
  });

  it("does not stack wake timers when more turns land inside the interval", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME),
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
    });

    for (let index = 0; index < 6; index += 1) {
      harness.completeTurn();
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.generationRequests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(300_000);
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.summaryWrites[0]?.consumedTurns).toBe(6);
    harness.service.dispose();
  });

  it("refreshes on the next completed turn when the persisted counter is already past the floor", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME - 600_000),
      summaryTurnsSinceUpdate: 3,
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
    });

    // Startup alone must not generate, even though both floors are satisfied.
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.generationRequests).toHaveLength(0);

    harness.completeTurn();
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.summaryWrites[0]?.consumedTurns).toBe(4);
    harness.service.dispose();
  });

  it("schedules the remaining interval at startup when the persisted counter is already met", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME - 100_000),
      summaryTurnsSinceUpdate: 3,
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.generationRequests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200_000);
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(1);
    harness.service.dispose();
  });

  it("skips content already covered by the persisted summary cursor after restart", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt: new Date(BASE_TIME),
      summaryCursor: { epoch: "epoch-1", seq: 2 },
      summaryTurnsSinceUpdate: 2,
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 0,
      timelineRows: [
        row(1, "2026-07-30T11:59:00.000Z", {
          type: "user_message",
          text: "Work already covered by the summary.",
        }),
        row(2, "2026-07-30T12:00:00.000Z", {
          type: "assistant_message",
          text: "Finished the summarized work.",
        }),
        row(3, "2026-07-30T12:01:00.000Z", {
          type: "user_message",
          text: "First turn after the summary.",
        }),
        row(4, "2026-07-30T12:02:00.000Z", {
          type: "assistant_message",
          text: "Finished the first follow-up.",
        }),
        row(5, "2026-07-30T12:03:00.000Z", {
          type: "user_message",
          text: "Second turn after the summary.",
        }),
        row(6, "2026-07-30T12:04:00.000Z", {
          type: "assistant_message",
          text: "Finished the second follow-up.",
        }),
      ],
    });

    harness.appendRow(
      row(7, "2026-07-30T12:05:00.000Z", {
        type: "user_message",
        text: "Third turn after the summary.",
      }),
    );
    harness.appendRow(
      row(8, "2026-07-30T12:06:00.000Z", {
        type: "assistant_message",
        text: "Finished the third follow-up.",
      }),
    );
    harness.completeTurn();
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.generationRequests[0]?.prompt).not.toContain(
      "Work already covered by the summary.",
    );
    expect(harness.generationRequests[0]?.prompt).toContain("Third turn after the summary.");
    harness.service.dispose();
  });

  it("uses only messages newer than the persisted summary timestamp", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    const summaryUpdatedAt = new Date("2026-07-30T12:05:00.000Z");
    const harness = createHarness({
      summary: "Old purpose.",
      summaryUpdatedAt,
      minTurnsBetweenGenerations: 1,
      minIntervalMs: 0,
      now: () => Date.parse("2026-07-30T12:07:00.000Z"),
      timelineRows: [
        row(1, "2026-07-30T12:00:00.000Z", {
          type: "user_message",
          text: "Old request that is already summarized.",
        }),
        row(2, "2026-07-30T12:06:00.000Z", {
          type: "user_message",
          text: "Now expose the summary in the UI.",
        }),
      ],
    });

    harness.completeTurn();
    await vi.runAllTimersAsync();

    const prompt = harness.generationRequests[0]?.prompt ?? "";
    expect(prompt).toContain("Now expose the summary in the UI.");
    expect(prompt).not.toContain("Old request that is already summarized.");
    harness.service.dispose();
  });

  it("keeps a turn that completes while generation is in flight for the next summary", async () => {
    vi.useFakeTimers({ now: BASE_TIME });
    let resolveFirstGeneration: ((value: { summary: string }) => void) | undefined;
    let generationCount = 0;
    const harness = createHarness({
      minTurnsBetweenGenerations: 1,
      minIntervalMs: 0,
      timelineRows: [
        row(1, "2026-07-30T12:00:00.000Z", {
          type: "user_message",
          text: "Implement the summary service.",
        }),
      ],
      generate: async () => {
        generationCount += 1;
        if (generationCount === 1) {
          return await new Promise<{ summary: string }>((resolvePromise) => {
            resolveFirstGeneration = resolvePromise;
          });
        }
        return { summary: "Includes the interleaved follow-up work." };
      },
    });

    harness.completeTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.generationRequests).toHaveLength(1);

    harness.appendRow(
      row(2, "2026-07-30T12:01:00.000Z", {
        type: "user_message",
        text: "Also cover the concurrency edge case.",
      }),
    );
    harness.completeTurn();
    resolveFirstGeneration?.({ summary: "Implements the initial summary service." });
    await vi.waitFor(() => expect(harness.summaryWrites).toHaveLength(1));
    expect(harness.summaryWrites[0]?.summaryCursor).toEqual({ epoch: "epoch-1", seq: 1 });
    // Only the turn captured when generation started is consumed.
    expect(harness.summaryWrites[0]?.consumedTurns).toBe(1);
    expect(harness.agent.summaryTurnsSinceUpdate).toBe(1);

    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(2);
    expect(harness.generationRequests[1]?.prompt).toContain(
      "Also cover the concurrency edge case.",
    );
    expect(harness.agent.summaryTurnsSinceUpdate).toBe(0);
    harness.service.dispose();
  });
});

interface HarnessInput {
  summary?: string | null;
  summaryUpdatedAt?: Date;
  summaryCursor?: { epoch: string; seq: number };
  summaryTurnsSinceUpdate?: number;
  timelineRows?: AgentTimelineRow[];
  minTurnsBetweenGenerations?: number;
  minIntervalMs?: number;
  now?: () => number;
  generate?: () => Promise<{ summary: string }>;
  includeAgentAtStart?: boolean;
}

function createHarness(input: HarnessInput = {}): Harness {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  const summaryWrites: SummaryWrite[] = [];
  const generationRequests: AgentPurposeSummaryGenerationRequest<unknown>[] = [];
  const timelineRows = input.timelineRows ?? [
    row(1, "2026-07-30T12:06:00.000Z", {
      type: "user_message",
      text: "Continue implementing summaries.",
    }),
  ];
  const agent = {
    id: AGENT_ID,
    cwd: "/tmp/project",
    internal: false,
    summary: input.summary ?? null,
    summaryUpdatedAt: input.summaryUpdatedAt,
    summaryCursor: input.summaryCursor,
    summaryTurnsSinceUpdate: input.summaryTurnsSinceUpdate ?? 0,
  } as unknown as ManagedAgent;

  const agentManager = {
    subscribe(callback: (event: AgentManagerEvent) => void) {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    },
    getAgent(agentId: string) {
      return agentId === AGENT_ID ? agent : null;
    },
    listAgents() {
      return input.includeAgentAtStart === false ? [] : [agent];
    },
    fetchTimeline(
      _agentId: string,
      options?: {
        direction?: "tail" | "before" | "after";
        cursor?: { epoch: string; seq: number };
      },
    ) {
      const maxSeq = timelineRows.at(-1)?.seq ?? 0;
      const cursor = options?.cursor;
      const selectedRows =
        options?.direction === "after" && cursor?.epoch === "epoch-1"
          ? timelineRows.filter((entry) => entry.seq > cursor.seq)
          : timelineRows;
      return {
        epoch: "epoch-1",
        direction: "tail" as const,
        reset: false,
        staleCursor: false,
        gap: false,
        window: {
          minSeq: timelineRows[0]?.seq ?? 0,
          maxSeq,
          nextSeq: maxSeq + 1,
        },
        hasOlder: false,
        hasNewer: false,
        rows: selectedRows,
      };
    },
    async setAgentSummary(
      _agentId: string,
      summary: string,
      options?: {
        expectedPreviousSummary?: string | null;
        summaryCursor?: { epoch: string; seq: number };
        consumedTurns?: number;
      },
    ) {
      if (
        options &&
        Object.prototype.hasOwnProperty.call(options, "expectedPreviousSummary") &&
        (agent.summary ?? null) !== options.expectedPreviousSummary
      ) {
        return false;
      }
      summaryWrites.push({
        summary,
        expectedPreviousSummary: options?.expectedPreviousSummary,
        summaryCursor: options?.summaryCursor,
        consumedTurns: options?.consumedTurns,
      });
      agent.summary = summary;
      agent.summaryUpdatedAt = new Date();
      agent.summaryCursor = options?.summaryCursor;
      const pending = agent.summaryTurnsSinceUpdate ?? 0;
      agent.summaryTurnsSinceUpdate = Math.max(0, pending - (options?.consumedTurns ?? pending));
      return true;
    },
  } as unknown as AgentPurposeSummaryOptions["agentManager"];

  const service = new AgentPurposeSummaryService({
    agentManager,
    generation: {
      async generate<T>(request: AgentPurposeSummaryGenerationRequest<T>): Promise<T> {
        generationRequests.push(request as AgentPurposeSummaryGenerationRequest<unknown>);
        const result = input.generate
          ? await input.generate()
          : {
              summary: "Adds rolling agent summaries and wires their persistence and UI.",
            };
        return result as T;
      },
    },
    logger: createTestLogger(),
    minTurnsBetweenGenerations: input.minTurnsBetweenGenerations,
    minIntervalMs: input.minIntervalMs,
    now: input.now,
  });
  service.start();

  return {
    agent,
    completeTurn: () => {
      agent.summaryTurnsSinceUpdate = (agent.summaryTurnsSinceUpdate ?? 0) + 1;
      subscriber?.(turnCompletedEvent());
    },
    generationRequests,
    summaryWrites,
    appendRow: (nextRow) => timelineRows.push(nextRow),
    publishState: () => subscriber?.({ type: "agent_state", agent }),
    service,
  };
}

function row(seq: number, timestamp: string, item: AgentTimelineItem): AgentTimelineRow {
  return { seq, timestamp, item };
}

function turnCompletedEvent(): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId: AGENT_ID,
    event: {
      type: "turn_completed",
      provider: "codex",
    },
  };
}

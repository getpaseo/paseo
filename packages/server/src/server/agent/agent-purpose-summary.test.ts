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

interface Harness {
  agent: ManagedAgent;
  emit: (event: AgentManagerEvent) => void;
  generationRequests: AgentPurposeSummaryGenerationRequest<unknown>[];
  summaryWrites: Array<{
    summary: string;
    expectedPreviousSummary: string | null | undefined;
    summaryCursor?: { epoch: string; seq: number };
  }>;
  appendRow: (row: AgentTimelineRow) => void;
  service: AgentPurposeSummaryService;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentPurposeSummaryService", () => {
  it("generates the first summary after the first completed turn", async () => {
    vi.useFakeTimers();
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

    harness.emit(turnCompletedEvent());
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
      },
    ]);
    harness.service.dispose();
  });

  it("waits for both the turn and time floors before refreshing an existing summary", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-07-30T12:10:00.000Z");
    const summaryUpdatedAt = new Date(now);
    const harness = createHarness({
      summary: "Initial purpose.",
      summaryUpdatedAt,
      now: () => now,
      minTurnsBetweenGenerations: 3,
      minIntervalMs: 300_000,
      timelineRows: [
        row(1, "2026-07-30T12:11:00.000Z", {
          type: "user_message",
          text: "Continue after the initial summary.",
        }),
      ],
    });

    harness.emit(turnCompletedEvent());
    harness.emit(turnCompletedEvent());
    harness.emit(turnCompletedEvent());
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(0);

    now += 300_000;
    harness.emit(turnCompletedEvent());
    await vi.runAllTimersAsync();
    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.summaryWrites[0]?.expectedPreviousSummary).toBe("Initial purpose.");
    harness.service.dispose();
  });

  it("uses only messages newer than the persisted summary timestamp", async () => {
    vi.useFakeTimers();
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

    harness.emit(turnCompletedEvent());
    await vi.runAllTimersAsync();

    const prompt = harness.generationRequests[0]?.prompt ?? "";
    expect(prompt).toContain("Now expose the summary in the UI.");
    expect(prompt).not.toContain("Old request that is already summarized.");
    harness.service.dispose();
  });

  it("keeps a turn that completes while generation is in flight for the next summary", async () => {
    vi.useFakeTimers();
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

    harness.emit(turnCompletedEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.generationRequests).toHaveLength(1);

    harness.appendRow(
      row(2, "2026-07-30T12:01:00.000Z", {
        type: "user_message",
        text: "Also cover the concurrency edge case.",
      }),
    );
    harness.emit(turnCompletedEvent());
    resolveFirstGeneration?.({ summary: "Implements the initial summary service." });
    await vi.waitFor(() => expect(harness.summaryWrites).toHaveLength(1));
    expect(harness.summaryWrites[0]?.summaryCursor).toEqual({ epoch: "epoch-1", seq: 1 });

    harness.appendRow(
      row(3, "2026-07-30T12:02:00.000Z", {
        type: "assistant_message",
        text: "Added the regression test.",
      }),
    );
    harness.emit(turnCompletedEvent());
    await vi.runAllTimersAsync();

    expect(harness.generationRequests).toHaveLength(2);
    expect(harness.generationRequests[1]?.prompt).toContain(
      "Also cover the concurrency edge case.",
    );
    harness.service.dispose();
  });
});

function createHarness(
  input: {
    summary?: string | null;
    summaryUpdatedAt?: Date;
    timelineRows?: AgentTimelineRow[];
    minTurnsBetweenGenerations?: number;
    minIntervalMs?: number;
    now?: () => number;
    generate?: () => Promise<{ summary: string }>;
  } = {},
): Harness {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  const summaryWrites: Harness["summaryWrites"] = [];
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
    fetchTimeline() {
      const maxSeq = timelineRows.at(-1)?.seq ?? 0;
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
        rows: timelineRows.map((entry) => ({ ...entry })),
      };
    },
    async setAgentSummary(
      _agentId: string,
      summary: string,
      options?: {
        expectedPreviousSummary?: string | null;
        summaryCursor?: { epoch: string; seq: number };
      },
    ) {
      summaryWrites.push({
        summary,
        expectedPreviousSummary: options?.expectedPreviousSummary,
        summaryCursor: options?.summaryCursor,
      });
      agent.summary = summary;
      agent.summaryCursor = options?.summaryCursor;
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
    emit: (event) => subscriber?.(event),
    generationRequests,
    summaryWrites,
    appendRow: (nextRow) => timelineRows.push(nextRow),
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

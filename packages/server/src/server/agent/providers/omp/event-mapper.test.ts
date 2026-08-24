import { describe, expect, test } from "vitest";

import { mapOmpRuntimeEventToTimelineItem } from "./event-mapper.js";

describe("OMP runtime event mapper", () => {
  test("maps notice events to timeline status lines", () => {
    const event = {
      type: "notice",
      level: "warning",
      message: "Provider quota is getting low",
      source: "anthropic",
    };

    expect(mapOmpRuntimeEventToTimelineItem(event)).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: expect.stringMatching(/^omp-notice:/),
        name: "omp_notice",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP warning notice from anthropic",
          text: "Provider quota is getting low",
          icon: "sparkles",
        },
        metadata: {
          synthetic: true,
          source: "omp_notice",
          level: "warning",
          eventSource: "anthropic",
        },
      },
    });
  });

  test("maps goal_updated events to provider notices and timeline status lines", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "goal_updated",
        goal: {
          id: "goal-1",
          objective: "Ship Phase 5",
          status: "active",
          tokenBudget: 2000,
          tokensUsed: 345,
          timeUsedSeconds: 12,
        },
        state: {
          enabled: true,
          mode: "active",
        },
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: "omp-goal:goal-1",
        name: "omp_goal_updated",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP goal active",
          text: "Ship Phase 5\nStatus: active\nTokens used: 345\nToken budget: 2000\nTime used: 12s\nMode: active",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_goal_updated",
          goalId: "goal-1",
          goalStatus: "active",
        },
      },
    });
  });

  test("maps retry telemetry to status-line timeline items", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 25,
        errorMessage: "retrying",
        errorId: 7,
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: "omp-auto-retry:1",
        name: "omp_auto_retry",
        status: "running",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP retry 1/3",
          text: "Retrying in 25ms: retrying",
          icon: "sparkles",
        },
        metadata: {
          source: "omp_auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 25,
          errorId: 7,
        },
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "still failed",
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        callId: "omp-auto-retry:1",
        name: "omp_auto_retry",
        status: "failed",
        error: "still failed",
        detail: {
          type: "plain_text",
          label: "OMP retry 1 failed",
          text: "still failed",
          icon: "sparkles",
        },
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "retry_fallback_applied",
        from: "anthropic/claude-sonnet",
        to: "openai/gpt-5",
        role: "primary",
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        name: "omp_retry_fallback",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP fallback applied for primary",
          text: "anthropic/claude-sonnet -> openai/gpt-5",
          icon: "sparkles",
        },
        metadata: {
          source: "omp_retry_fallback_applied",
          role: "primary",
          from: "anthropic/claude-sonnet",
          to: "openai/gpt-5",
        },
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "retry_fallback_succeeded",
        model: "openai/gpt-5",
        role: "primary",
      }),
    ).toMatchObject({
      handled: true,
      item: {
        type: "tool_call",
        name: "omp_retry_fallback",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: "OMP fallback succeeded for primary",
          text: "Using openai/gpt-5",
          icon: "sparkles",
        },
        metadata: {
          source: "omp_retry_fallback_succeeded",
          role: "primary",
          model: "openai/gpt-5",
        },
      },
    });
  });

  test("maps auto compaction events to compaction timeline items", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      }),
    ).toEqual({
      handled: true,
      item: {
        type: "compaction",
        status: "loading",
        trigger: "auto",
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_compaction_end",
        action: "context-full",
        result: {
          summary: "trimmed",
          shortSummary: "trimmed",
          firstKeptEntryId: "entry-1",
          tokensBefore: 123,
        },
        aborted: false,
        willRetry: false,
      }),
    ).toEqual({
      handled: true,
      item: {
        type: "compaction",
        status: "completed",
        trigger: "auto",
        preTokens: 123,
      },
    });

    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "auto_compaction_end",
        aborted: true,
        willRetry: true,
        skipped: true,
        errorMessage: "compaction failed",
      }),
    ).toEqual({
      handled: true,
      item: {
        type: "compaction",
        status: "completed",
        trigger: "auto",
      },
    });
  });

  test("leaves unknown events unhandled", () => {
    expect(mapOmpRuntimeEventToTimelineItem({ type: "message_start" })).toEqual({
      handled: false,
    });
  });

  test("log-drops malformed known OMP events", () => {
    expect(
      mapOmpRuntimeEventToTimelineItem({
        type: "notice",
        level: "loud",
        message: "bad",
      }),
    ).toEqual({
      handled: true,
      item: null,
      logReason: "malformed_omp_notice",
    });
  });
});

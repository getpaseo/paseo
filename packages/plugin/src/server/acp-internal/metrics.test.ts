import { describe, expect, it } from "vitest";
import {
  buildAcpSessionMetrics,
  buildAcpTurnMetrics,
  createEmptySessionMetricTotals,
  recordTurnMetrics,
} from "./metrics.js";

describe("ACP metrics formatting", () => {
  it("formats turn metrics with model, duration, tokens, cache hit tone, thinking, and cost", () => {
    expect(
      buildAcpTurnMetrics({
        modelLabel: "Gemini 2.5 Pro",
        durationMs: 2_340,
        usage: {
          inputTokens: 2049,
          outputTokens: 109,
          cachedReadTokens: 7523,
          cachedWriteTokens: 0,
          thoughtTokens: 64,
          totalTokens: 9681,
        },
        costUsd: 0.0124,
      }),
    ).toEqual([
      { label: "Model", value: "Gemini 2.5 Pro" },
      { label: "Elapsed", value: "2.3s" },
      { label: "Tokens", value: "9.6K ↑ · 109 ↓" },
      { label: "Cache", value: "79%", tone: "ok" },
      { label: "Thinking", value: "64" },
      { label: "Cost", value: "$0.012" },
    ]);
  });

  it("accumulates running session totals across turns", () => {
    const totals = createEmptySessionMetricTotals();
    recordTurnMetrics(totals, 1_500, {
      inputTokens: 1_000,
      outputTokens: 200,
      cachedReadTokens: 500,
      totalTokens: 1_700,
    });
    recordTurnMetrics(totals, 62_000, {
      inputTokens: 500,
      outputTokens: 300,
      cachedReadTokens: 1_500,
      totalTokens: 2_300,
    });
    totals.costUsd = 1.25;

    expect(buildAcpSessionMetrics(totals)).toEqual([
      { label: "Turns", value: "2" },
      { label: "Active", value: "1m 4s" },
      { label: "Tokens", value: "3.5K ↑ · 500 ↓" },
      { label: "Cache", value: "57%", tone: "ok" },
      { label: "Cost", value: "$1.25" },
    ]);
  });
});

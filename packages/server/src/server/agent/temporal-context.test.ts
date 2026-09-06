import { describe, expect, test } from "vitest";

import {
  formatToolResultTemporalContext,
  formatUserMessageTemporalContext,
  type TemporalClock,
} from "./temporal-context.js";

function createClock(): TemporalClock {
  return {
    wallTime: () => new Date("2026-09-06T18:32:18.421Z"),
    monotonicTime: () => 42,
    timeZone: "America/New_York",
  };
}

describe("temporal context", () => {
  test("identifies when Paseo received a user message", () => {
    expect(formatUserMessageTemporalContext(createClock())).toBe(
      '<paseo_temporal_context kind="user_message" received_at="2026-09-06T18:32:18.421Z" timezone="America/New_York" />',
    );
  });

  test("identifies when a tool completed and its monotonic duration", () => {
    expect(formatToolResultTemporalContext(createClock(), 1246.7)).toBe(
      '<paseo_temporal_context kind="tool_result" completed_at="2026-09-06T18:32:18.421Z" timezone="America/New_York" duration_ms="1247" />',
    );
  });

  test("does not expose negative duration from a clock adjustment", () => {
    expect(formatToolResultTemporalContext(createClock(), -1)).toContain('duration_ms="0"');
  });
});

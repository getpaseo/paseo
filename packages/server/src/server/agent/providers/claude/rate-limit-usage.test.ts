import { expect, test } from "vitest";
import { readClaudeRateLimitUsage } from "./rate-limit-usage.js";

test("falls back to the window the event names when unifiedWindows is missing or reshaped", () => {
  expect(
    readClaudeRateLimitUsage({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.07,
      resetsAt: 1795725600,
      unifiedWindows: { five_hour: "unexpected", seven_day: { utilization: "high" } },
    }),
  ).toEqual([{ id: "five_hour", usedPct: 7, resetsAt: "2026-11-26T20:40:00.000Z" }]);
});

test("ignores windows the usage report has no window for", () => {
  expect(
    readClaudeRateLimitUsage({
      status: "allowed",
      rateLimitType: "seven_day_opus",
      utilization: 0.5,
      unifiedWindows: { overage: { utilization: 0.2 } },
    }),
  ).toEqual([]);
});

test("reads nothing from an event that is not an object", () => {
  expect(readClaudeRateLimitUsage(null)).toBeNull();
  expect(readClaudeRateLimitUsage({ status: "allowed" })).toEqual([]);
});

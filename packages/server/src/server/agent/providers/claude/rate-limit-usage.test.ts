import { expect, test } from "vitest";
import { readClaudeRateLimitUsage } from "./rate-limit-usage.js";

test("reads five_hour and seven_day from unifiedWindows into canonical Claude UsageWindows", () => {
  expect(
    readClaudeRateLimitUsage({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.9,
      resetsAt: 1795917600,
      unifiedWindows: {
        five_hour: { utilization: 0.73, resetsAt: 1795725600, status: "allowed" },
        seven_day: { utilization: 0.9, resetsAt: 1795917600, status: "allowed_warning" },
      },
    }),
  ).toEqual([
    {
      id: "five_hour",
      label: "Session",
      shortLabel: "5h",
      summary: true,
      usedPct: 73,
      remainingPct: 27,
      durationSeconds: 18_000,
      resetsAt: "2026-11-26T20:40:00.000Z",
      tone: "warning",
    },
    {
      id: "weekly",
      label: "Weekly",
      shortLabel: "wk",
      summary: true,
      usedPct: 90,
      remainingPct: 10,
      durationSeconds: 604_800,
      resetsAt: "2026-11-29T02:00:00.000Z",
      tone: "warning",
    },
  ]);
});

test("falls back to the window the event names when unifiedWindows is missing or reshaped", () => {
  expect(
    readClaudeRateLimitUsage({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.07,
      resetsAt: 1795725600,
      unifiedWindows: { five_hour: "unexpected", seven_day: { utilization: "high" } },
    }),
  ).toEqual([
    {
      id: "five_hour",
      label: "Session",
      shortLabel: "5h",
      summary: true,
      usedPct: 7,
      remainingPct: 93,
      durationSeconds: 18_000,
      resetsAt: "2026-11-26T20:40:00.000Z",
      tone: "ok",
    },
  ]);
});

test("ignores windows the usage report has no canonical mapping for", () => {
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

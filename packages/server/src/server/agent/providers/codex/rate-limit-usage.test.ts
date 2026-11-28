import { expect, test } from "vitest";
import { readCodexRateLimitUsage } from "./rate-limit-usage.js";

test("reads primary, secondary, individual spend limit, credits, and planType from a Codex rateLimits snapshot", () => {
  expect(
    readCodexRateLimitUsage({
      limitId: "codex",
      limitName: null,
      planType: "pro",
      primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1795725600 },
      secondary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: 1795917600 },
      individualLimit: { limit: "100", used: "15", remainingPercent: 85, resetsAt: 1796000000 },
      credits: { hasCredits: true, unlimited: false, balance: "42.5" },
    }),
  ).toEqual({
    planLabel: "pro",
    windows: [
      {
        id: "five_hour",
        label: "5-hour",
        shortLabel: "5h",
        summary: true,
        usedPct: 24,
        remainingPct: 76,
        durationSeconds: 18_000,
        resetsAt: "2026-11-26T20:40:00.000Z",
        tone: "ok",
      },
      {
        id: "weekly",
        label: "Weekly",
        shortLabel: "wk",
        summary: true,
        usedPct: 92,
        remainingPct: 8,
        durationSeconds: 604_800,
        resetsAt: "2026-11-29T02:00:00.000Z",
        tone: "danger",
      },
      {
        id: "individual_limit",
        label: "Individual spend limit",
        summary: true,
        usedPct: 15,
        remainingPct: 85,
        resetsAt: "2026-11-30T00:53:20.000Z",
        tone: "ok",
      },
    ],
    balances: [
      {
        id: "credits",
        label: "Credits",
        remaining: 42.5,
        unit: "credits",
        tone: "ok",
      },
    ],
  });
});

test("scopes non-default Codex limitId buckets without marking them summary", () => {
  expect(
    readCodexRateLimitUsage({
      limitId: "codex_bengalfox",
      limitName: "Codex Spark",
      primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    }),
  ).toEqual({
    windows: [
      {
        id: "limit:codex_bengalfox:five_hour",
        label: "Codex Spark · 5-hour",
        shortLabel: "Codex Spark 5h",
        usedPct: 70,
        remainingPct: 30,
        durationSeconds: 18_000,
        resetsAt: null,
        tone: "warning",
      },
    ],
    balances: [],
  });
});

test("returns null for non-object payloads and ignores empty credit strings", () => {
  expect(readCodexRateLimitUsage(null)).toBeNull();
  expect(
    readCodexRateLimitUsage({
      primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null },
      secondary: "malformed",
      credits: { balance: "   " },
    }),
  ).toEqual({
    windows: [
      {
        id: "unknown_primary",
        label: "Primary limit",
        shortLabel: "",
        summary: true,
        usedPct: 10,
        remainingPct: 90,
        resetsAt: null,
        tone: "ok",
      },
    ],
    balances: [],
  });
});

import { describe, expect, test } from "vitest";
import { excludedWaitMs, goalDeadlineMs, timeLimitEndMs } from "./time-limit.js";
import type { GoalConfig, GoalWaits } from "./types.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const at = (minute: number) => new Date(T0 + minute * MIN).toISOString();

function goal(waits?: GoalWaits, config: GoalConfig = { limits: { goalTimeoutMinutes: 60 } }) {
  return { createdAt: at(0), config, ...(waits ? { waits } : {}) };
}

describe("the time limit and waits for a person's answer", () => {
  test("without waits the limit ends a goal timeout after the time base", () => {
    expect(timeLimitEndMs(goal(), T0)).toBe(T0 + 60 * MIN);
    expect(excludedWaitMs(goal(), T0 + 30 * MIN)).toBe(0);
  });

  test("closed waits push the end back by their time", () => {
    const g = goal({ open: {}, excludedMs: 20 * MIN, since: null });
    expect(timeLimitEndMs(g, T0 + 90 * MIN)).toBe(T0 + 80 * MIN);
  });

  test("an open wait moves the end with now", () => {
    const g = goal({ open: { a1: { since: at(50) } }, excludedMs: 5 * MIN, since: at(50) });
    expect(excludedWaitMs(g, T0 + 70 * MIN)).toBe(25 * MIN);
    expect(timeLimitEndMs(g, T0 + 70 * MIN)).toBe(T0 + 85 * MIN);
    expect(timeLimitEndMs(g, T0 + 100 * MIN)).toBe(T0 + 115 * MIN);
  });

  test("the absolute deadline is not pushed back", () => {
    const g = goal(
      { open: {}, excludedMs: 120 * MIN, since: null },
      { limits: { goalTimeoutMinutes: 60, deadlineAt: at(90) } },
    );
    expect(goalDeadlineMs(g, T0)).toBe(T0 + 90 * MIN);
  });
});

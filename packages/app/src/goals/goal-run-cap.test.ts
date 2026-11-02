import { describe, expect, it } from "vitest";
import { stepScrubValue } from "@/utils/scrub-number";
import {
  GOAL_RUN_CAP_DEFAULT,
  GOAL_RUN_CAP_FIELD,
  goalRunCapOf,
  goalRunCapPatch,
} from "./goal-run-cap";

describe("goal run cap", () => {
  it("reads the host's value, or the daemon default when the host has none", () => {
    expect(GOAL_RUN_CAP_DEFAULT).toBe(4);
    expect(goalRunCapOf(null)).toBe(4);
    expect(goalRunCapOf({})).toBe(4);
    expect(goalRunCapOf({ goals: {} })).toBe(4);
    expect(goalRunCapOf({ goals: { maxConcurrentRuns: 9 } })).toBe(9);
  });

  it("saves only a changed whole number inside 1 to 32", () => {
    expect(goalRunCapPatch(null, 6)).toEqual({ goals: { maxConcurrentRuns: 6 } });
    expect(goalRunCapPatch(null, 4)).toBeNull();
    expect(goalRunCapPatch({ goals: { maxConcurrentRuns: 6 } }, 6)).toBeNull();
    expect(goalRunCapPatch({ goals: { maxConcurrentRuns: 6 } }, 4)).toEqual({
      goals: { maxConcurrentRuns: 4 },
    });
    for (const bad of [0, 33, 2.5]) expect(goalRunCapPatch(null, bad)).toBeNull();
  });

  it("is typed on the number pad and scrubbed one run at a time within its range", () => {
    expect(GOAL_RUN_CAP_FIELD.inputMode).toBe("numeric");
    expect(GOAL_RUN_CAP_FIELD.format.parse("8")).toBe(8);
    expect(GOAL_RUN_CAP_FIELD.format.parse("2.5")).toBeUndefined();
    expect(stepScrubValue(GOAL_RUN_CAP_FIELD.scale, 4, 1)).toBe(5);
    expect(stepScrubValue(GOAL_RUN_CAP_FIELD.scale, 32, 1)).toBe(32);
    expect(stepScrubValue(GOAL_RUN_CAP_FIELD.scale, 1, -1)).toBe(1);
  });
});

import { describe, expect, test } from "vitest";

import {
  selectIsPreventingSleep,
  selectIsSleepPreventionSupported,
  selectSleepPreventionAgentCount,
  type SleepPreventionSessionSlice,
} from "./sleep-prevention-selectors";

function sessions(
  entries: Record<string, SleepPreventionSessionSlice>,
): Record<string, SleepPreventionSessionSlice> {
  return entries;
}

describe("sleep prevention indicator state", () => {
  test("shows nothing when no host reports holding", () => {
    const state = sessions({
      a: { sleepPrevention: { active: false, supported: true, agentCount: 0 } },
    });

    expect(selectIsPreventingSleep(state)).toBe(false);
    expect(selectSleepPreventionAgentCount(state)).toBe(0);
  });

  test("shows nothing for a host running agents it cannot keep awake", () => {
    const state = sessions({
      a: { sleepPrevention: { active: false, supported: false, agentCount: 3 } },
    });

    expect(selectIsPreventingSleep(state)).toBe(false);
    expect(selectSleepPreventionAgentCount(state)).toBe(0);
  });

  test("shows when any host is holding, and totals the agents across hosts", () => {
    const state = sessions({
      a: { sleepPrevention: { active: true, supported: true, agentCount: 2 } },
      b: { sleepPrevention: { active: false, supported: true, agentCount: 0 } },
      c: { sleepPrevention: { active: true, supported: true, agentCount: 1 } },
    });

    expect(selectIsPreventingSleep(state)).toBe(true);
    expect(selectSleepPreventionAgentCount(state)).toBe(3);
  });

  test("shows nothing for a host whose state was cleared on disconnect", () => {
    const state = sessions({ a: { sleepPrevention: null }, b: {} });

    expect(selectIsPreventingSleep(state)).toBe(false);
    expect(selectSleepPreventionAgentCount(state)).toBe(0);
  });

  test("treats a host as capable until the daemon reports otherwise", () => {
    expect(selectIsSleepPreventionSupported(undefined)).toBe(true);
    expect(selectIsSleepPreventionSupported({ sleepPrevention: null })).toBe(true);
    expect(
      selectIsSleepPreventionSupported({
        sleepPrevention: { active: false, supported: false, agentCount: 0 },
      }),
    ).toBe(false);
  });
});

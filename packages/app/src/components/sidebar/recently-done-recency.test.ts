import { describe, expect, it } from "vitest";
import { resolveRecencyTiming, resolveServerClockOffsetMs } from "./recently-done-recency";

describe("resolveRecencyTiming", () => {
  it("disables both recency timers while the sidebar is inactive", () => {
    expect(
      resolveRecencyTiming({
        active: false,
        isStatusMode: true,
        recentlyDoneWindowMinutes: 15,
      }),
    ).toEqual({ windowMs: 0, tickIntervalMs: null });
  });

  it("ticks only for an active status-grouped sidebar with a configured window", () => {
    expect(
      resolveRecencyTiming({
        active: true,
        isStatusMode: true,
        recentlyDoneWindowMinutes: 15,
      }),
    ).toEqual({ windowMs: 15 * 60_000, tickIntervalMs: 60_000 });
  });
});

describe("resolveServerClockOffsetMs", () => {
  it("uses client and server midpoints to remove clock skew from recency ages", () => {
    expect(
      resolveServerClockOffsetMs({
        clientSentAt: 1_000,
        clientReceivedAt: 1_100,
        serverReceivedAt: 4_020,
        serverSentAt: 4_040,
      }),
    ).toBe(2_980);
  });
});

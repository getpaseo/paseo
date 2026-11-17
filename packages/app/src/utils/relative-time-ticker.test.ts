import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeRelativeTimeTickerCount,
  followCompactTimeUntil,
  subscribeToRelativeTimeTick,
} from "./relative-time-ticker";

const MINUTE = 60_000;

describe("subscribeToRelativeTimeTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Align the clock so the first tick lands a whole period later, not part-way through one.
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs no timer until something subscribes", () => {
    expect(activeRelativeTimeTickerCount()).toBe(0);
  });

  it("ticks a subscriber at its tier's period", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToRelativeTimeTick("minute", listener);

    vi.advanceTimersByTime(MINUTE);
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MINUTE);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("shares one timer across every subscriber at the same tier", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeToRelativeTimeTick("minute", first);
    const unsubSecond = subscribeToRelativeTimeTick("minute", second);

    // Fifty rows must not mean fifty timers; the tier count is what proves it.
    expect(activeRelativeTimeTickerCount()).toBe(1);

    vi.advanceTimersByTime(MINUTE);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubFirst();
    unsubSecond();
  });

  it("stops the timer when the last subscriber leaves", () => {
    const unsubFirst = subscribeToRelativeTimeTick("minute", vi.fn());
    const unsubSecond = subscribeToRelativeTimeTick("minute", vi.fn());

    unsubFirst();
    expect(activeRelativeTimeTickerCount()).toBe(1);

    unsubSecond();
    expect(activeRelativeTimeTickerCount()).toBe(0);
  });

  it("runs tiers independently", () => {
    const minute = vi.fn();
    const hour = vi.fn();
    const unsubMinute = subscribeToRelativeTimeTick("minute", minute);
    const unsubHour = subscribeToRelativeTimeTick("hour", hour);

    expect(activeRelativeTimeTickerCount()).toBe(2);

    vi.advanceTimersByTime(MINUTE);
    expect(minute).toHaveBeenCalledTimes(1);
    expect(hour).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30 * MINUTE);
    expect(hour).toHaveBeenCalledTimes(1);

    unsubMinute();
    unsubHour();
    expect(activeRelativeTimeTickerCount()).toBe(0);
  });

  it("survives a listener unsubscribing during its own tick", () => {
    const survivor = vi.fn();
    let unsubSelf = () => {};
    const quitter = vi.fn(() => unsubSelf());

    unsubSelf = subscribeToRelativeTimeTick("minute", quitter);
    const unsubSurvivor = subscribeToRelativeTimeTick("minute", survivor);

    expect(() => vi.advanceTimersByTime(MINUTE)).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MINUTE);
    expect(quitter).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(2);

    unsubSurvivor();
  });
});

describe("followCompactTimeUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Half-way through a wall-clock minute, so the wall clock and the countdown disagree.
    vi.setSystemTime(new Date("2026-11-13T20:02:30.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("changes when the time left reaches a whole minute, not on the wall clock's minute", () => {
    // A `/loop` wake published by a dev daemon, due 334 ms past a minute.
    const labels: string[] = [];
    followCompactTimeUntil(new Date("2026-11-13T20:04:00.334Z"), (label) => labels.push(label));
    expect(labels).toEqual(["2m"]);

    // The wall clock's minute passes with a minute and a millisecond still left.
    vi.advanceTimersByTime(30_333);
    expect(labels).toEqual(["2m"]);

    vi.advanceTimersByTime(1);
    expect(labels).toEqual(["2m", "<1m"]);
    // "<1m" is final until the wake moves, so nothing is left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the next change in one timer, however far away", () => {
    const labels: string[] = [];
    const stop = followCompactTimeUntil(new Date("2026-11-13T21:32:30.000Z"), (label) =>
      labels.push(label),
    );
    expect(labels).toEqual(["1h"]);
    expect(vi.getTimerCount()).toBe(1);

    // "1h" holds until 59 minutes are left.
    vi.advanceTimersByTime(31 * MINUTE - 1);
    expect(labels).toEqual(["1h"]);
    vi.advanceTimersByTime(1);
    expect(labels).toEqual(["1h", "59m"]);

    stop();
  });

  it("clears its timer when stopped", () => {
    const labels: string[] = [];
    const stop = followCompactTimeUntil(new Date("2026-11-13T20:12:30.000Z"), (label) =>
      labels.push(label),
    );
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(labels).toEqual(["10m"]);
  });
});

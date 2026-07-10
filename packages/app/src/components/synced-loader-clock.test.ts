import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedStepClock } from "@/components/synced-loader-clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSharedStepClock", () => {
  it("advances a shared cadence only while at least one consumer is subscribed", () => {
    vi.useFakeTimers();
    const clock = createSharedStepClock(6, 960);
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const unsubscribeFirst = clock.subscribe(firstListener);
    const unsubscribeSecond = clock.subscribe(secondListener);
    vi.advanceTimersByTime(320);

    expect(clock.getSnapshot()).toBe(2);
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    vi.advanceTimersByTime(160);
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    vi.advanceTimersByTime(640);
    expect(clock.getSnapshot()).toBe(3);
    expect(secondListener).toHaveBeenCalledTimes(3);
  });
});

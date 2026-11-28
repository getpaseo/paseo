// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { Animated } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_RING_PERIOD_MS } from "./geometry";

const panel = vi.hoisted(() => ({ active: true }));
vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => panel.active,
}));

const { useStatusRingProgress } = await import("./clock.native");

describe("useStatusRingProgress", () => {
  let start: ReturnType<typeof vi.fn<() => void>>;
  let stop: ReturnType<typeof vi.fn<() => void>>;
  let timing: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    panel.active = true;
    start = vi.fn<() => void>();
    stop = vi.fn<() => void>();
    timing = vi.spyOn(Animated, "timing");
    vi.spyOn(Animated, "loop").mockReturnValue({ start, stop, reset: vi.fn() });
    vi.spyOn(Date, "now").mockReturnValue(STATUS_RING_PERIOD_MS * 7 + STATUS_RING_PERIOD_MS / 4);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns one period on the native driver from the shared wall-clock phase", () => {
    const { result, unmount } = renderHook(() => useStatusRingProgress());

    expect(timing).toHaveBeenCalledTimes(1);
    const [value, config] = timing.mock.calls[0]!;
    expect(value).toBe(result.current);
    expect(config).toMatchObject({
      toValue: 1.25,
      duration: STATUS_RING_PERIOD_MS,
      useNativeDriver: true,
    });
    expect((result.current as unknown as { __getValue(): number }).__getValue()).toBe(0.25);
    expect(start).toHaveBeenCalledTimes(1);

    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not animate a ring in a hidden retained panel", () => {
    panel.active = false;
    renderHook(() => useStatusRingProgress());

    expect(timing).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

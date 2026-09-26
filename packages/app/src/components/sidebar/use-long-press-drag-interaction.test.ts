// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { GestureResponderEvent } from "react-native";

vi.mock("expo-haptics", () => ({
  selectionAsync: () => Promise.resolve(),
  impactAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Medium: "medium" },
}));

vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));

import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";

const pressEvent = (x: number, y: number) =>
  ({ nativeEvent: { pageX: x, pageY: y } }) as unknown as GestureResponderEvent;

const moveEvent = (x: number, y: number) =>
  ({ nativeEvent: { touches: [{ pageX: x, pageY: y }] } }) as unknown as GestureResponderEvent;

describe("useLongPressDragInteraction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a stationary press-and-hold a tap", () => {
    const drag = vi.fn();
    const { result } = renderHook(() =>
      useLongPressDragInteraction({ drag, menuController: null }),
    );

    act(() => {
      result.current.handlePressIn(pressEvent(10, 10));
      vi.advanceTimersByTime(300);
      result.current.handlePressOut();
    });

    expect(drag).not.toHaveBeenCalled();
    expect(result.current.didLongPressRef.current).toBe(false);
  });

  it("starts the drag once an armed press moves past the slop", () => {
    const drag = vi.fn();
    const { result } = renderHook(() =>
      useLongPressDragInteraction({ drag, menuController: null }),
    );

    act(() => {
      result.current.handlePressIn(pressEvent(10, 10));
      vi.advanceTimersByTime(300);
      result.current.handleTouchMove(moveEvent(10, 40));
    });

    expect(drag).toHaveBeenCalledTimes(1);
    expect(result.current.didLongPressRef.current).toBe(true);
  });
});

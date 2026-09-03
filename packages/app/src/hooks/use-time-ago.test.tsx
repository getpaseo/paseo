/**
 * @vitest-environment jsdom
 */
import { useSyncExternalStore } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeRelativeTimeTickerCount } from "@/utils/relative-time-ticker";
import { useTimeAgo } from "./use-time-ago";

let appVisible = true;
const visibilityListeners = new Set<() => void>();

vi.mock("@/hooks/use-app-visible", () => ({
  useAppVisible: () =>
    useSyncExternalStore(
      (listener: () => void) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
      () => appVisible,
      () => appVisible,
    ),
}));

function setAppVisible(visible: boolean): void {
  appVisible = visible;
  for (const listener of visibilityListeners) listener();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fixed at call time: the hook is keyed on the instant, not on "how long ago" per render. */
function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

describe("useTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Aligned to the wall clock so the first tick of a tier lands a whole period later.
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    appVisible = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves the label on when the minute rolls over", () => {
    const date = ago(MINUTE);
    const { result, unmount } = renderHook(() => useTimeAgo(date));
    expect(result.current).toBe("1m ago");

    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(result.current).toBe("2m ago");

    unmount();
    expect(activeRelativeTimeTickerCount()).toBe(0);
  });

  it("follows the label into a slower tier as it ages", () => {
    const date = ago(59 * MINUTE);
    const { result, unmount } = renderHook(() => useTimeAgo(date));
    expect(result.current).toBe("59m ago");

    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(result.current).toBe("1h ago");

    // Now on the hour tier and only there; the minute tier has nothing left to wake for.
    expect(activeRelativeTimeTickerCount()).toBe(1);

    // That tier wakes every half hour, so the label lands within thirty minutes of the turn.
    act(() => void vi.advanceTimersByTime(90 * MINUTE));
    expect(result.current).toBe("2h ago");

    unmount();
  });

  it("runs no timer for a label that can never change again", () => {
    const date = ago(8 * DAY);
    const { result, unmount } = renderHook(() => useTimeAgo(date));
    expect(result.current).toBe("Jul 8");
    expect(activeRelativeTimeTickerCount()).toBe(0);

    unmount();
  });

  it("stops ticking while hidden and catches the label up on the way back", () => {
    const date = ago(MINUTE);
    const { result, unmount } = renderHook(() => useTimeAgo(date));
    expect(result.current).toBe("1m ago");

    act(() => setAppVisible(false));
    expect(activeRelativeTimeTickerCount()).toBe(0);

    act(() => void vi.advanceTimersByTime(5 * MINUTE));
    expect(result.current).toBe("1m ago");

    // Not "2m ago" a minute later: coming back recomputes rather than resuming where it left off.
    act(() => setAppVisible(true));
    expect(result.current).toBe("6m ago");

    unmount();
  });

  it("renders nothing, and subscribes to nothing, without a date", () => {
    const { result, unmount } = renderHook(() => useTimeAgo(null));
    expect(result.current).toBe("");
    expect(activeRelativeTimeTickerCount()).toBe(0);

    unmount();
  });
});

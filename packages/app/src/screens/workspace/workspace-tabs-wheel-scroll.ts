import { useEffect, useRef, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { isWeb } from "@/constants/platform";

// Wheel events report `deltaMode` in DOM units: pixels, lines, or pages. Only pixel
// deltas are usable as-is; the other two need the axis size to become a scroll offset.
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT_PX = 16;

export interface WorkspaceTabsWheelScrollInput {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}

export interface WorkspaceTabsWheelScrollResult {
  scrollLeft: number;
  handled: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Resolve a wheel event on the workspace tab strip into a horizontal scroll offset.
 *
 * `handled: false` leaves the event to the browser: there is nothing to scroll, the
 * gesture already carries horizontal intent (`deltaX` trackpad swipe or shift+wheel),
 * or the strip is already pinned at the requested edge.
 */
export function resolveWorkspaceTabsWheelScroll(
  input: WorkspaceTabsWheelScrollInput,
): WorkspaceTabsWheelScrollResult {
  const maxScrollLeft = Math.max(0, input.scrollWidth - input.clientWidth);
  const currentScrollLeft = clamp(input.scrollLeft, 0, maxScrollLeft);
  if (maxScrollLeft <= 0) {
    return { scrollLeft: currentScrollLeft, handled: false };
  }
  if (input.shiftKey || input.ctrlKey || input.deltaX !== 0) {
    return { scrollLeft: currentScrollLeft, handled: false };
  }
  let delta = input.deltaY;
  if (input.deltaMode === WHEEL_DELTA_MODE_LINE) {
    delta = input.deltaY * WHEEL_LINE_HEIGHT_PX;
  } else if (input.deltaMode === WHEEL_DELTA_MODE_PAGE) {
    delta = input.deltaY * input.clientWidth;
  }
  if (delta === 0) {
    return { scrollLeft: currentScrollLeft, handled: false };
  }
  const nextScrollLeft = clamp(currentScrollLeft + delta, 0, maxScrollLeft);
  return { scrollLeft: nextScrollLeft, handled: nextScrollLeft !== currentScrollLeft };
}

/**
 * A React Native Web ScrollView ref resolves to the ScrollView instance, whose
 * `getScrollableNode()` returns the overflowing element. A platform that hands back the
 * element itself (or a test double) is used as-is; anything without an `addEventListener`
 * is not a scrollable element and is ignored.
 */
export function resolveWorkspaceTabsScrollElement(handle: unknown): HTMLElement | null {
  if (!handle || typeof handle !== "object") {
    return null;
  }
  const scrollableNode = (handle as { getScrollableNode?: () => unknown }).getScrollableNode;
  if (typeof scrollableNode === "function") {
    const node = scrollableNode.call(handle);
    return isScrollElement(node) ? node : null;
  }
  return isScrollElement(handle) ? handle : null;
}

function isScrollElement(candidate: unknown): candidate is HTMLElement {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    typeof (candidate as { addEventListener?: unknown }).addEventListener === "function"
  );
}

/**
 * Let a plain vertical mouse wheel pan the overflowing workspace tab strip.
 *
 * React registers `wheel` as a passive listener, so `onWheel` cannot stop the browser
 * default; a native listener is required to consume the vertical gesture. The hook is a
 * no-op outside the web runtime and while the strip fits its viewport.
 */
export function useWorkspaceTabsWheelScroll(enabled: boolean): RefObject<ScrollView | null> {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!isWeb || !enabled) {
      return;
    }
    const node = resolveWorkspaceTabsScrollElement(scrollRef.current);
    if (!node) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      const result = resolveWorkspaceTabsWheelScroll({
        scrollLeft: node.scrollLeft,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
      });
      if (!result.handled) {
        return;
      }
      node.scrollLeft = result.scrollLeft;
      event.preventDefault();
    };

    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [enabled]);

  return scrollRef;
}

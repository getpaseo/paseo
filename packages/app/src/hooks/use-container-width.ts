import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

/**
 * Reads a real width out of a layout event. Retained tabs stay mounted under
 * `display: none`, so an inactive panel emits width 0 — that is "not rendered",
 * not "very narrow", and must never drive a width-based collapse.
 */
export function readMeasuredWidth(event: LayoutChangeEvent): number | null {
  const width = event.nativeEvent.layout.width;
  return width > 0 ? width : null;
}

/**
 * Tracks the width of a container via onLayout.
 */
export function useContainerWidth(): {
  onLayout: (e: LayoutChangeEvent) => void;
  width: number;
} {
  const [width, setWidth] = useState(0);
  return {
    onLayout: useCallback((e: LayoutChangeEvent) => {
      setWidth(e.nativeEvent.layout.width);
    }, []),
    width,
  };
}

/**
 * Tracks only whether a container is narrower than a threshold.
 */
export function useContainerWidthBelow(
  threshold: number,
  options?: { initialIsBelow?: boolean },
): {
  onLayout: (e: LayoutChangeEvent) => void;
  isBelow: boolean;
} {
  const [isBelow, setIsBelow] = useState(options?.initialIsBelow ?? true);
  return {
    onLayout: useCallback(
      (e: LayoutChangeEvent) => {
        const width = readMeasuredWidth(e);
        if (width === null) {
          return;
        }
        const nextIsBelow = width < threshold;
        setIsBelow((currentIsBelow) =>
          currentIsBelow === nextIsBelow ? currentIsBelow : nextIsBelow,
        );
      },
      [threshold],
    ),
    isBelow,
  };
}

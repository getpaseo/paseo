import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

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
        const width = e.nativeEvent.layout.width;
        if (width <= 0) {
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

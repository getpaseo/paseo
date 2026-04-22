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

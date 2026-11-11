import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

export function useWorkspaceViewport() {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  return { width, onLayout };
}

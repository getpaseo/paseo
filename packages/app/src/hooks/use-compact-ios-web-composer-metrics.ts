import { useSharedValue, type SharedValue } from "react-native-reanimated";

export interface CompactIosWebComposerMetrics {
  offset: SharedValue<number | null>;
  dockFillDepth: SharedValue<number>;
}

export function useCompactIosWebComposerMetrics(_enabled: boolean): CompactIosWebComposerMetrics {
  const offset = useSharedValue<number | null>(null);
  const dockFillDepth = useSharedValue(0);
  return { offset, dockFillDepth };
}

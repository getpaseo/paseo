import { useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTopBand } from "./context";

export interface WindowLayoutTopInsetProps {
  additionalPadding?: number;
}

export function WindowLayoutTopInset({ additionalPadding = 0 }: WindowLayoutTopInsetProps) {
  const insets = useSafeAreaInsets();
  const topBand = useTopBand();
  const height = insets.top + (topBand ? 0 : additionalPadding);
  const style = useMemo(() => ({ height, flexShrink: 0 }), [height]);
  return <View pointerEvents="none" style={style} />;
}

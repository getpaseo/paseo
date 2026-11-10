import type { ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { requireNativeViewManager } from "expo-modules-core";
import { useTopBand } from "./context";
import type { WindowLayoutTopInsetProps } from "./top-inset";

const NativeTopInset = requireNativeViewManager<
  ViewProps & { additionalPadding: number; unownedInset: number }
>("PaseoWindowLayout", "WindowLayoutTopInsetView");
const insetStyle = { flexShrink: 0 };

export function WindowLayoutTopInset({ additionalPadding = 0 }: WindowLayoutTopInsetProps) {
  const insets = useSafeAreaInsets();
  const topBand = useTopBand();
  const unownedInset = insets.top + (topBand ? 0 : additionalPadding);
  return (
    <NativeTopInset
      pointerEvents="none"
      style={insetStyle}
      additionalPadding={additionalPadding}
      unownedInset={unownedInset}
    />
  );
}

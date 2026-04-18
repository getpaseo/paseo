import { useMemo } from "react";
import type { ViewStyle } from "react-native";
import { useUnistyles } from "react-native-unistyles";

// CSS scrollbar properties are supported by React Native Web at runtime
// but are not included in React Native's ViewStyle type definition.
interface WebScrollbarStyle extends ViewStyle {
  scrollbarColor: string;
  scrollbarWidth: string;
}

export function useWebScrollbarStyle(): WebScrollbarStyle {
  const { theme } = useUnistyles();
  return useMemo(
    (): WebScrollbarStyle => ({
      scrollbarColor: `${theme.colors.scrollbarHandle} transparent`,
      scrollbarWidth: "thin",
    }),
    [theme.colors.scrollbarHandle],
  );
}

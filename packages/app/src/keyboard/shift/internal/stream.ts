import { useMemo } from "react";
import { Platform } from "react-native";
import { useSettledKeyboardShift } from "./context";
import { resolveStreamKeyboardInset } from "./policy";

/** Preserve the translated inverted list's far-end scroll range only after motion settles. */
export function useKeyboardStreamInset() {
  const settledShift = useSettledKeyboardShift();
  return useMemo(
    () =>
      resolveStreamKeyboardInset({
        platform: Platform.OS === "ios" ? "ios" : "android",
        settledShift,
      }),
    [settledShift],
  );
}

import { useMemo } from "react";
import { Platform } from "react-native";
import { useSettledKeyboardShift } from "./context";
import { resolveStreamKeyboardInset } from "./policy";

/** Keep the oldest rows of the translated list reachable, only after motion settles. */
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

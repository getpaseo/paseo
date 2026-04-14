import { useMemo } from "react";
import { useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

/**
 * Returns a style object that themes native scrollbars on web using CSS
 * `scrollbar-color`. Returns `undefined` on native (no-op).
 */
export function useWebScrollbarStyle() {
  const { theme } = useUnistyles();
  return useMemo(
    () =>
      isWeb
        ? ({
            scrollbarColor: `${theme.colors.scrollbarHandle} transparent`,
            scrollbarWidth: "thin",
          } as any)
        : undefined,
    [theme.colors.scrollbarHandle],
  );
}

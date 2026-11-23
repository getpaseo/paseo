import { useContext, type ReactNode } from "react";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { WindowInsetsContext } from "./context";

/**
 * Gives an overlay that draws over the whole window, such as an RN `Modal`, the window's insets
 * instead of the ones its call site was given. Read them below it with `useSafeAreaInsets()`.
 */
export function WindowSafeArea({ children }: { children: ReactNode }) {
  const insets = useContext(WindowInsetsContext);
  if (!insets) {
    throw new Error("WindowSafeArea must render inside WindowLayoutProvider");
  }
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}

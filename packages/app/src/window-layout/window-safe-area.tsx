import { useContext, type ReactNode } from "react";
import { SafeAreaInsetsContext, type EdgeInsets } from "react-native-safe-area-context";
import { WindowInsetsContext } from "./context";

/**
 * The window's insets, for content that draws against the window instead of the surface it was
 * rendered in: an overlay over the layout surface, or a panel in a portal host outside it.
 */
export function useWindowSafeAreaInsets(): EdgeInsets {
  const insets = useContext(WindowInsetsContext);
  if (!insets) {
    throw new Error("useWindowSafeAreaInsets must be used inside WindowLayoutProvider");
  }
  return insets;
}

/**
 * Gives an overlay that draws over the whole window, such as an RN `Modal`, the window's insets
 * instead of the ones its call site was given. Read them below it with `useSafeAreaInsets()`.
 */
export function WindowSafeArea({ children }: { children: ReactNode }) {
  const insets = useWindowSafeAreaInsets();
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}

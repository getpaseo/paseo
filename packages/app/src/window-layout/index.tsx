import type { ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WindowInsetsContext } from "./context";

export { useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export { useTopBand } from "./context";
export { WindowSafeArea } from "./window-safe-area";
export {
  resolveDesktopDivisionLayout,
  resolveHeaderBesideStatusBar,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, TopBand, WindowLayout, WindowLayoutRect } from "./model";
export {
  getVerticalBar,
  setVerticalBarBehavior,
  subscribeVerticalBar,
  useVerticalBarDisabled,
  type VerticalBarBehavior,
  type VerticalBarState,
} from "./vertical-bar";

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <WindowInsetsContext.Provider value={insets}>{children}</WindowInsetsContext.Provider>;
}

import type { ReactNode } from "react";

export { useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export { useTopBand } from "./context";
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
  return children;
}

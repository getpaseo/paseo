import { EXPLORER_WORKSPACE_MIN_WIDTH } from "@/components/explorer-sidebar-layout";
import { SETTINGS_DESKTOP_SPLIT_MIN_WIDTH } from "@/constants/layout";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  type LeftSidebarPresentation,
} from "@/stores/panel-store";
import type { DesktopDivisionLayout } from "@/window-layout";

const MIN_DESKTOP_CENTER_WIDTH = 400;

export function resolveDesktopSidebarVisibility(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isMounted: boolean;
  isOpen: boolean;
  canShare: boolean;
  divisionLayout?: DesktopDivisionLayout | null;
}): boolean {
  return (
    input.chromeEnabled &&
    !input.isCompactLayout &&
    input.isMounted &&
    (input.divisionLayout != null || (input.isOpen && input.canShare))
  );
}

/**
 * Compact layouts always present navigation as a drawer overlay. Wide layouts dock it when it is
 * visible and fall back to an overlay when the dock is collapsed or yields its width.
 */
export function resolveLeftSidebarPresentation(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isFocusModeEnabled: boolean;
  desktopSidebarVisible: boolean;
}): LeftSidebarPresentation {
  if (!input.chromeEnabled) return "hidden";
  if (input.isCompactLayout) return "overlay";
  if (input.isFocusModeEnabled) return "hidden";
  return input.desktopSidebarVisible ? "dock" : "overlay";
}

/**
 * The overlay sidebar starts at the window's left edge, over the workspace's safe-area padding, so
 * its content takes the left inset itself. The dock sits inside app chrome, which already pads it.
 */
export function resolveDesktopSidebarInsetLeft(input: {
  overlay: boolean;
  safeAreaLeft: number;
}): number {
  return input.overlay ? input.safeAreaLeft : 0;
}

export function resolveDesktopAppChromeLayout(input: {
  desktopSidebarRendered: boolean;
  hasTopLeftWindowControls: boolean;
  sidebarControlsEnabled: boolean;
}) {
  const sidebarOwnsTopLeft = input.desktopSidebarRendered && input.hasTopLeftWindowControls;
  let sidebarToggleOwner: "none" | "window" | "content" = "none";
  if (input.sidebarControlsEnabled) {
    sidebarToggleOwner = input.hasTopLeftWindowControls ? "window" : "content";
  }
  return {
    sidebarCorners: sidebarOwnsTopLeft ? ("top-left" as const) : ("none" as const),
    contentCorners: sidebarOwnsTopLeft ? ("top-right" as const) : ("both" as const),
    sidebarToggleOwner,
  };
}

function resolveDesktopPanelWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
  minimumWidth: number;
  maximumWidth: number;
}): number {
  "worklet";
  const maximumVisibleWidth = Math.max(
    input.minimumWidth,
    Math.min(input.maximumWidth, input.viewportWidth - MIN_DESKTOP_CENTER_WIDTH),
  );
  return Math.max(input.minimumWidth, Math.min(maximumVisibleWidth, input.requestedWidth));
}

export function resolveDesktopSidebarWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
}): number {
  "worklet";
  return resolveDesktopPanelWidth({
    ...input,
    minimumWidth: MIN_SIDEBAR_WIDTH,
    maximumWidth: MAX_SIDEBAR_WIDTH,
  });
}

export function resolveDesktopAppContentMinimum(input: {
  isSettingsRoute: boolean;
  explorerVisible?: boolean;
}): number {
  if (input.isSettingsRoute) return SETTINGS_DESKTOP_SPLIT_MIN_WIDTH;
  return input.explorerVisible ? EXPLORER_WORKSPACE_MIN_WIDTH : 0;
}

export function canDesktopAppSidebarShare(input: {
  contentMinimumWidth: number;
  requestedSidebarWidth: number;
  viewportWidth: number;
}): boolean {
  return (
    input.viewportWidth -
      resolveDesktopSidebarWidth({
        requestedWidth: input.requestedSidebarWidth,
        viewportWidth: input.viewportWidth,
      }) >=
    input.contentMinimumWidth
  );
}

export function resolveSidebarActivity(
  visible: boolean,
  compact: boolean,
  mobileActive: boolean,
): boolean {
  return visible && (!compact || mobileActive);
}

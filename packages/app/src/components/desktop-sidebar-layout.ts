import { SETTINGS_DESKTOP_DETAIL_MIN_WIDTH } from "@/constants/layout";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";
import {
  MIN_WORKSPACE_BODY_WIDTH,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";

const MIN_DESKTOP_CENTER_WIDTH = 400;

export function resolveDesktopSidebarVisibility(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isMounted: boolean;
  isOpen: boolean;
  canShare: boolean;
}): boolean {
  return (
    input.chromeEnabled &&
    !input.isCompactLayout &&
    input.isMounted &&
    input.isOpen &&
    input.canShare
  );
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

interface DesktopAppContentMinimumInput {
  isSettingsRoute: boolean;
  isWorkspaceExplorerOpen: boolean;
  requestedSidebarWidth: number;
  requestedExplorerSidebarWidth?: number;
  viewportWidth: number;
}

export function resolveDesktopAppContentMinimum(input: DesktopAppContentMinimumInput): number {
  if (input.isSettingsRoute) {
    const sidebarWidth = resolveDesktopSidebarWidth({
      requestedWidth: input.requestedSidebarWidth,
      viewportWidth: input.viewportWidth,
    });
    return sidebarWidth + SETTINGS_DESKTOP_DETAIL_MIN_WIDTH;
  }
  if (input.isWorkspaceExplorerOpen) {
    // Resolve against the viewport so navigation cannot shrink Explorer when it returns.
    const explorerWidth = resolveExplorerSidebarWidth({
      requestedWidth: input.requestedExplorerSidebarWidth,
      containerWidth: input.viewportWidth,
    });
    return explorerWidth + MIN_WORKSPACE_BODY_WIDTH;
  }
  return 0;
}

export function canDesktopAppSidebarShare(input: {
  contentMinimumWidth: number;
  requestedSidebarWidth: number;
  viewportWidth: number;
}): boolean {
  return (
    input.viewportWidth >=
    resolveDesktopSidebarWidth({
      requestedWidth: input.requestedSidebarWidth,
      viewportWidth: input.viewportWidth,
    }) +
      input.contentMinimumWidth
  );
}

import { EXPLORER_WORKSPACE_MIN_WIDTH } from "@/components/explorer-sidebar-layout";
import { SETTINGS_DESKTOP_SPLIT_MIN_WIDTH } from "@/constants/layout";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";
import type { ContentBandGeometry } from "@/components/headers/content-band-geometry.shared";

export interface DesktopDivisionLayout {
  sidebarWidth: number;
  gap: number;
  contentWidth: number;
}

/** A book-like division owns the two panes; horizontal folds keep the existing flow. */
export function resolveDesktopDivisionLayout(input: {
  geometry: Pick<ContentBandGeometry, "bounds" | "divisions"> | null;
  windowWidth: number;
  windowHeight: number;
  leftInset: number;
  rightInset: number;
  minimumSidebarWidth: number;
  minimumContentWidth: number;
}): DesktopDivisionLayout | null {
  const { geometry, windowWidth, windowHeight } = input;
  if (
    !geometry ||
    Math.abs(geometry.bounds.width - windowWidth) > 0.5 ||
    Math.abs(geometry.bounds.height - windowHeight) > 0.5
  )
    return null;
  const divisions = geometry.divisions.filter(
    (frame) =>
      frame.width > 0 &&
      frame.height > frame.width &&
      frame.y < windowHeight &&
      frame.y + frame.height > 0,
  );
  // This shell has two panes, so it can represent one vertical partition.
  if (divisions.length !== 1) return null;
  const division = divisions[0];
  const sidebarWidth = division.x - input.leftInset;
  const contentWidth = windowWidth - input.rightInset - division.x - division.width;
  if (
    sidebarWidth < input.minimumSidebarWidth ||
    contentWidth <= 0 ||
    contentWidth < input.minimumContentWidth
  )
    return null;
  return { sidebarWidth, gap: division.width, contentWidth };
}

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
  minimumWidth: number;
}): number {
  "worklet";
  return resolveDesktopPanelWidth({
    ...input,
    minimumWidth: Math.max(MIN_SIDEBAR_WIDTH, input.minimumWidth),
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
  sidebarMinimumWidth: number;
  viewportWidth: number;
  divisionLayout?: DesktopDivisionLayout | null;
}): boolean {
  if (input.divisionLayout) {
    return (
      input.divisionLayout.sidebarWidth >= input.sidebarMinimumWidth &&
      input.divisionLayout.contentWidth >= input.contentMinimumWidth
    );
  }
  return (
    input.viewportWidth -
      resolveDesktopSidebarWidth({
        requestedWidth: input.requestedSidebarWidth,
        viewportWidth: input.viewportWidth,
        minimumWidth: input.sidebarMinimumWidth,
      }) >=
    input.contentMinimumWidth
  );
}

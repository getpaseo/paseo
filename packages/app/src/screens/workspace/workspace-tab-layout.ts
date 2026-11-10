import { COMPACT_CONTENT_WIDTH } from "@/constants/layout";
import { resolveWorkspaceActionPlacement, type WindowLayout } from "@/window-layout/model";

export function shouldUseInlineWorkspaceHeader(
  layout: WindowLayout | null,
  compact = false,
  focusMode = false,
): boolean {
  return (
    !compact &&
    !focusMode &&
    layout !== null &&
    layout.bounds.width > layout.bounds.height &&
    resolveWorkspaceActionPlacement(layout) === "vertical-bar"
  );
}

export function shouldUseCompactWorkspaceHeader(width: number): boolean {
  return width < COMPACT_CONTENT_WIDTH;
}

export const WORKSPACE_INLINE_TABS_MIN_WIDTH = 320;
export type WorkspaceInlineTabPresentation = "tabs" | "switcher";

export function resolveInlineWorkspaceTabPresentation(
  width: number,
  naturalWidth: number | null,
  current: WorkspaceInlineTabPresentation = "tabs",
): WorkspaceInlineTabPresentation {
  if (width >= WORKSPACE_INLINE_TABS_MIN_WIDTH) return "tabs";
  if (naturalWidth === null) return current;
  return naturalWidth <= width ? "tabs" : "switcher";
}

export function resolveInlineWorkspaceTabBudget({
  width,
  horizontalInset,
  leadingWidth,
  gap,
}: {
  width: number;
  horizontalInset: number;
  leadingWidth: number;
  gap: number;
}): number {
  const contentWidth = Math.max(0, width - horizontalInset);
  return Math.max(0, contentWidth - Math.min(leadingWidth, contentWidth / 3) - gap);
}

export type WorkspaceTabCloseButtonPolicy = "all" | "none";

export interface WorkspaceTabLayoutMetrics {
  rowHorizontalInset: number;
  actionsReservedWidth: number;
  rowPaddingHorizontal: number;
  tabGap: number;
  minTabWidth: number;
  maxTabWidth: number;
  tabIconWidth: number;
  tabContentGap: number;
  tabHorizontalPadding: number;
  closeButtonWidth: number;
}

export interface WorkspaceTabLayoutInput {
  viewportWidth: number;
  tabLabelWidths: number[];
  metrics: WorkspaceTabLayoutMetrics;
  /**
   * Compact layouts are touch-first. Tabs keep their natural width and the row scrolls as soon as
   * they overflow, so a label is never squeezed to make room; chips carry no inline close because a
   * narrow X beside the label is easy to hit by accident and the tab's long-press menu closes it.
   */
  compact: boolean;
  /** Embedded rails preserve tab widths and scroll independently of close-button sizing. */
  preserveNaturalWidths?: boolean;
}

export interface WorkspaceTabLayoutItem {
  width: number;
  showLabel: boolean;
}

export interface WorkspaceTabLayoutResult {
  items: WorkspaceTabLayoutItem[];
  closeButtonPolicy: WorkspaceTabCloseButtonPolicy;
  requiresHorizontalScrollFallback: boolean;
}

export function workspaceTabNaturalWidth(
  layout: WorkspaceTabLayoutResult,
  metrics: WorkspaceTabLayoutMetrics,
): number {
  return (
    layout.items.reduce((width, item) => width + item.width, 0) +
    metrics.rowHorizontalInset * 2 +
    metrics.rowPaddingHorizontal * 2 +
    Math.max(0, layout.items.length - 1) * metrics.tabGap +
    metrics.actionsReservedWidth
  );
}

export function retainWorkspaceTabMeasuredWidth(
  currentWidth: number,
  measuredWidth: number,
): number {
  if (measuredWidth <= 0 || Math.abs(currentWidth - measuredWidth) <= 1) {
    return currentWidth;
  }
  return measuredWidth;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput,
): WorkspaceTabLayoutResult {
  const tabCount = input.tabLabelWidths.length;
  const closeButtonPolicy: WorkspaceTabCloseButtonPolicy = input.compact ? "none" : "all";
  if (tabCount === 0) {
    return {
      items: [],
      closeButtonPolicy,
      requiresHorizontalScrollFallback: false,
    };
  }

  const availableWidth = Math.max(
    0,
    input.viewportWidth - input.metrics.rowHorizontalInset * 2 - input.metrics.actionsReservedWidth,
  );
  const rowOverhead =
    input.metrics.rowPaddingHorizontal * 2 + Math.max(tabCount - 1, 0) * input.metrics.tabGap;
  const availableTabsWidth = Math.max(0, availableWidth - rowOverhead);
  const tabChromeWidth =
    input.metrics.tabIconWidth +
    input.metrics.tabContentGap +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const naturalWidths = input.tabLabelWidths.map((labelWidth) =>
    clamp(tabChromeWidth + labelWidth, input.metrics.minTabWidth, input.metrics.maxTabWidth),
  );
  const naturalTotalWidth = naturalWidths.reduce((total, width) => total + width, 0);
  const minimumTotalWidth = input.metrics.minTabWidth * tabCount;
  const scrollNaturally = input.compact || input.preserveNaturalWidths === true;
  // A row that scrolls has no reason to truncate: the tabs keep their natural widths and the
  // viewport pans over them. Ordinary pointer rails shrink first; compact and explicitly scrolling
  // rails keep their natural widths.
  const requiresHorizontalScrollFallback = scrollNaturally
    ? naturalTotalWidth > availableTabsWidth
    : availableTabsWidth < minimumTotalWidth;

  let resolvedWidths = naturalWidths;
  if (
    !requiresHorizontalScrollFallback &&
    !scrollNaturally &&
    naturalTotalWidth > availableTabsWidth
  ) {
    const widthToRemove = naturalTotalWidth - availableTabsWidth;
    const shrinkCapacity = naturalTotalWidth - minimumTotalWidth;
    const shrinkRatio = widthToRemove / shrinkCapacity;
    resolvedWidths = naturalWidths.map(
      (width) => width - (width - input.metrics.minTabWidth) * shrinkRatio,
    );
  }

  const roundedWidths = resolvedWidths.map((width) =>
    Math.round(clamp(width, input.metrics.minTabWidth, input.metrics.maxTabWidth)),
  );

  return {
    items: roundedWidths.map((width) => ({
      width,
      showLabel: width > tabChromeWidth,
    })),
    closeButtonPolicy,
    requiresHorizontalScrollFallback,
  };
}

export function selectWorkspaceChrome<Compact, Full>(input: {
  width: number | null;
  compact: Compact;
  full: Full;
}): Compact | Full {
  const compact = input.width !== null && shouldUseCompactWorkspaceHeader(input.width);
  return compact ? input.compact : input.full;
}

// A count badge is only 16pt wide. Native popovers need a content width floor
// because their scrolling tab list does not contribute an intrinsic width.
export const workspaceTabSwitcherPopoverLayout = { desktopMinWidth: 320 } as const;

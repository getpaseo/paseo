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

export interface WorkspaceTabPriority {
  index: number;
  maxWidth: number;
}

export interface WorkspaceTabLayoutInput {
  activeTab: WorkspaceTabPriority | null;
  viewportWidth: number;
  tabLabelWidths: number[];
  metrics: WorkspaceTabLayoutMetrics;
  /**
   * Compact layouts are touch-first. Tabs keep their natural width and the row scrolls as soon as
   * they overflow, so a label is never squeezed to make room; chips carry no inline close because a
   * narrow X beside the label is easy to hit by accident and the tab's long-press menu closes it.
   */
  compact: boolean;
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
  const activeIndex = input.activeTab?.index;
  const naturalWidths = input.tabLabelWidths.map((labelWidth, index) => {
    let maxWidth = input.metrics.maxTabWidth;
    if (input.activeTab && index === activeIndex) {
      const singleTabSpace =
        availableWidth - input.metrics.rowPaddingHorizontal * 2 - input.metrics.tabGap;
      maxWidth = Math.max(
        input.metrics.minTabWidth,
        Math.min(input.activeTab.maxWidth, singleTabSpace),
      );
    }
    return clamp(tabChromeWidth + labelWidth, input.metrics.minTabWidth, maxWidth);
  });
  // Touch users need to identify the current tab without hover. Reserve its content width
  // before shrinking its neighbors; when that no longer fits, keep it readable and scroll.
  const minimumWidths = naturalWidths.map((width, index) =>
    index === activeIndex ? width : input.metrics.minTabWidth,
  );
  const naturalTotalWidth = naturalWidths.reduce((total, width) => total + width, 0);
  const minimumTotalWidth = minimumWidths.reduce((total, width) => total + width, 0);
  // Scrolling rows retain natural widths; compact rows never shrink labels.
  const requiresHorizontalScrollFallback = input.compact
    ? naturalTotalWidth > availableTabsWidth
    : availableTabsWidth < minimumTotalWidth;

  let resolvedWidths = naturalWidths;
  if (
    !requiresHorizontalScrollFallback &&
    !input.compact &&
    naturalTotalWidth > availableTabsWidth
  ) {
    const widthToRemove = naturalTotalWidth - availableTabsWidth;
    const shrinkCapacity = naturalTotalWidth - minimumTotalWidth;
    const shrinkRatio = widthToRemove / shrinkCapacity;
    resolvedWidths = naturalWidths.map(
      (width, index) => width - (width - minimumWidths[index]) * shrinkRatio,
    );
  }

  const roundedWidths = resolvedWidths.map((width) =>
    input.activeTab ? Math.floor(width) : Math.round(width),
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

export type WorkspaceTabCloseButtonPolicy = "all";

export type WorkspaceTabLayoutInput = {
  viewportWidth: number;
  tabLabelLengths: number[];
  metrics: {
    rowHorizontalInset: number;
    actionsReservedWidth: number;
    rowPaddingHorizontal: number;
    tabGap: number;
    maxTabWidth: number;
    tabIconWidth: number;
    tabHorizontalPadding: number;
    estimatedCharWidth: number;
    closeButtonWidth: number;
  };
};

export type WorkspaceTabLayoutItem = {
  width: number;
  showLabel: boolean;
  labelCharCap: number;
};

export type WorkspaceTabLayoutResult = {
  items: WorkspaceTabLayoutItem[];
  closeButtonPolicy: WorkspaceTabCloseButtonPolicy;
  requiresHorizontalScrollFallback: boolean;
};

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
  const tabCount = input.tabLabelLengths.length;
  if (tabCount === 0) {
    return {
      items: [],
      closeButtonPolicy: "all",
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
  const iconOnlyTabWidth =
    input.metrics.tabIconWidth +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const iconOnlyTotalTabsWidth = iconOnlyTabWidth * tabCount;
  const requiresHorizontalScrollFallback = availableTabsWidth < iconOnlyTotalTabsWidth;
  const resolvedWidths = new Array(tabCount).fill(
    requiresHorizontalScrollFallback
      ? iconOnlyTabWidth
      : clamp(availableTabsWidth / tabCount, iconOnlyTabWidth, input.metrics.maxTabWidth),
  );

  const roundedWidths = resolvedWidths.map((width) =>
    Math.round(clamp(width, iconOnlyTabWidth, input.metrics.maxTabWidth)),
  );

  return {
    items: roundedWidths.map((width) => {
      const rawCharCap = Math.floor((width - iconOnlyTabWidth) / input.metrics.estimatedCharWidth);
      const labelCharCap = Math.max(0, rawCharCap);
      return {
        width,
        showLabel: labelCharCap > 0,
        labelCharCap,
      };
    }),
    closeButtonPolicy: "all",
    requiresHorizontalScrollFallback,
  };
}

const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 320;
const MIN_EXPLORER_SIDEBAR_WIDTH = 240;
const MIN_WORKSPACE_BODY_WIDTH = 360;
export const EXPLORER_WORKSPACE_MIN_WIDTH = MIN_EXPLORER_SIDEBAR_WIDTH + MIN_WORKSPACE_BODY_WIDTH;

export function resolveExplorerSidebarWidth(input: {
  requestedWidth?: number;
  containerWidth: number;
}): number {
  "worklet";
  const requestedWidth = input.requestedWidth ?? DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  const maximumVisibleWidth =
    input.containerWidth > 0
      ? Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, input.containerWidth - MIN_WORKSPACE_BODY_WIDTH)
      : requestedWidth;
  return Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, Math.min(maximumVisibleWidth, requestedWidth));
}

// A release keeps its UI width until React acknowledges it or replaces its allocation.
// Null pendingWidth means the gesture still owns the live resizeWidth instead.
export interface ExplorerSidebarResize {
  sourceWidths: number[];
  restoreWidth: number;
  containerWidth: number;
  pendingWidth: number | null;
}

interface ExplorerSidebarAllocation {
  width: number;
  containerWidth: number;
  overlay: boolean;
  resizeEnabled: boolean;
}

export function reconcileExplorerSidebarResize(
  resize: ExplorerSidebarResize | null,
  allocation: ExplorerSidebarAllocation,
): ExplorerSidebarResize | null {
  "worklet";
  if (
    !resize ||
    allocation.overlay ||
    !allocation.resizeEnabled ||
    allocation.containerWidth !== resize.containerWidth ||
    !resize.sourceWidths.includes(allocation.width) ||
    (allocation.width === resize.pendingWidth &&
      resize.sourceWidths.indexOf(allocation.width) === resize.sourceWidths.length - 1)
  ) {
    return null;
  }
  const acknowledgedIndex = resize.sourceWidths.indexOf(allocation.width);
  return acknowledgedIndex > 0
    ? { ...resize, sourceWidths: resize.sourceWidths.slice(acknowledgedIndex) }
    : resize;
}

export function beginExplorerSidebarResize(
  previous: ExplorerSidebarResize | null,
  allocation: ExplorerSidebarAllocation,
): ExplorerSidebarResize {
  "worklet";
  const current = reconcileExplorerSidebarResize(previous, allocation);
  // Released widths remain expected allocations while a newer gesture owns the frame.
  const sourceWidths = current ? [...current.sourceWidths] : [allocation.width];
  if (current && current.pendingWidth !== null && !sourceWidths.includes(current.pendingWidth))
    sourceWidths.push(current.pendingWidth);
  return {
    sourceWidths,
    restoreWidth: current ? (current.pendingWidth ?? current.restoreWidth) : allocation.width,
    containerWidth: allocation.containerWidth,
    pendingWidth: null,
  };
}

export function finishExplorerSidebarResize(
  resize: ExplorerSidebarResize | null,
  width: number,
  success: boolean,
): ExplorerSidebarResize | null {
  "worklet";
  if (!resize || resize.pendingWidth !== null) return resize;
  if (success) return { ...resize, pendingWidth: width };
  return resize.sourceWidths.length > 1 ? { ...resize, pendingWidth: resize.restoreWidth } : null;
}

export function resolveExplorerSidebarFrameWidth(
  allocation: ExplorerSidebarAllocation & {
    resize: ExplorerSidebarResize | null;
    resizeWidth: number;
  },
): number {
  "worklet";
  if (allocation.overlay) return allocation.containerWidth;
  const resize = reconcileExplorerSidebarResize(allocation.resize, allocation);
  return resize ? (resize.pendingWidth ?? allocation.resizeWidth) : allocation.width;
}

export function resolveExplorerSidebarDockSizes(input: {
  requestedWidth?: number;
  containerWidth: number;
}): number[] {
  if (input.containerWidth <= 0) {
    return [1, 0];
  }
  const width = resolveExplorerSidebarWidth(input);
  const ratio = width / input.containerWidth;
  return [1 - ratio, ratio];
}

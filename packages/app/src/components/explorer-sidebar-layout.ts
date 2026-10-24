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

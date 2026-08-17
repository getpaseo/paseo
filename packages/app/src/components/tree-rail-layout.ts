import { MIN_TREE_RAIL_WIDTH, clampTreeRailWidth } from "@/stores/panel-store";

const MIN_CONTENT_WIDTH = 240;

export function resolveVisibleTreeRailWidth(
  requestedWidth: number,
  containerWidth: number,
): number {
  const maximumVisibleWidth = Math.max(MIN_TREE_RAIL_WIDTH, containerWidth - MIN_CONTENT_WIDTH);
  return Math.min(clampTreeRailWidth(requestedWidth), maximumVisibleWidth);
}

export function acceptTreeRailContainerMeasurement(
  currentWidth: number,
  measuredWidth: number,
): number {
  return measuredWidth > 0 ? measuredWidth : currentWidth;
}

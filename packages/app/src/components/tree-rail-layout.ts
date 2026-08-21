import { MIN_TREE_RAIL_WIDTH } from "@/stores/panel-store";

const MIN_CONTENT_WIDTH = 240;

export function resolveVisibleTreeRailWidth(
  requestedWidth: number,
  containerWidth: number,
  minimumWidth = MIN_TREE_RAIL_WIDTH,
): number {
  const maximumVisibleWidth = Math.max(minimumWidth, containerWidth - MIN_CONTENT_WIDTH);
  return Math.min(Math.max(minimumWidth, Math.min(600, requestedWidth)), maximumVisibleWidth);
}

export function acceptTreeRailContainerMeasurement(
  currentWidth: number,
  measuredWidth: number,
): number {
  return measuredWidth > 0 ? measuredWidth : currentWidth;
}

export interface TerminalGridCellMetrics {
  cellWidth: number;
  cellHeight: number;
}

export function resolveTerminalGridMetricsMeasurement(
  previous: TerminalGridCellMetrics | null,
  next: TerminalGridCellMetrics,
): TerminalGridCellMetrics | null {
  if (previous?.cellWidth === next.cellWidth && previous.cellHeight === next.cellHeight) {
    return null;
  }
  return next;
}

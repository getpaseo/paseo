export interface TerminalMeasuredLayout {
  width: number;
  height: number;
}

export interface TerminalMeasuredCellMetrics {
  cellWidth: number;
  cellHeight: number;
}

export interface TerminalMeasuredSize {
  rows: number;
  cols: number;
}

export function resolveMeasuredNativeTerminalSize(input: {
  layout: TerminalMeasuredLayout | null;
  metrics: TerminalMeasuredCellMetrics | null;
}): TerminalMeasuredSize | null {
  if (!input.layout || !input.metrics) {
    return null;
  }
  const cols = Math.floor(input.layout.width / input.metrics.cellWidth);
  const rows = Math.floor(input.layout.height / input.metrics.cellHeight);
  if (cols <= 0 || rows <= 0) {
    return null;
  }
  return { rows, cols };
}

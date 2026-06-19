export interface TerminalGridCellMetrics {
  cellWidth: number;
  cellHeight: number;
}

export interface TerminalGridCellMetricsInput {
  measuredTextWidth: number;
  measuredTextHeight: number;
  measureTextLength: number;
  roundToNearestPixel: (value: number) => number;
}

export interface TerminalCursorOffsetInput {
  cursorCol: number;
  cursorRow: number;
  metrics: TerminalGridCellMetrics;
}

export interface TerminalCursorOffset {
  x: number;
  y: number;
}

export function resolveMeasuredTerminalCellMetrics(
  input: TerminalGridCellMetricsInput,
): TerminalGridCellMetrics {
  const textLength = Math.max(1, input.measureTextLength);
  return {
    cellWidth: Math.max(1, input.measuredTextWidth / textLength),
    cellHeight: snapCellHeight(input.measuredTextHeight, input.roundToNearestPixel),
  };
}

export function resolveTerminalCursorOffset(
  input: TerminalCursorOffsetInput,
): TerminalCursorOffset {
  return {
    x: input.cursorCol * input.metrics.cellWidth,
    y: input.cursorRow * input.metrics.cellHeight,
  };
}

function snapCellHeight(value: number, roundToNearestPixel: (value: number) => number): number {
  return Math.max(1, Math.ceil(roundToNearestPixel(value)));
}

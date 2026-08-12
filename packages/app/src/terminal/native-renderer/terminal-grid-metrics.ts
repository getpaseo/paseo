export interface TerminalGridCellMetrics {
  cellWidth: number;
  cellHeight: number;
}

export interface TerminalGridCellMetricsInput {
  measuredTextWidth: number;
  measuredTextHeight: number;
  measureTextLength: number;
  /** Cell-height multiplier; undefined means 1.0 (cell hugs the measured glyph box). */
  lineHeight?: number;
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

export interface TerminalCustomGlyphCellTransformInput {
  cellOffset: number;
  cellWidth: number;
  cellHeight: number;
}

export function resolveTerminalCustomGlyphCellTransform(
  input: TerminalCustomGlyphCellTransformInput,
): string {
  const translateX = input.cellOffset * input.cellWidth;
  return `matrix(${input.cellWidth} 0 0 ${input.cellHeight} ${translateX} 0)`;
}

export function resolveMeasuredTerminalCellMetrics(
  input: TerminalGridCellMetricsInput,
): TerminalGridCellMetrics {
  const textLength = Math.max(1, input.measureTextLength);
  // Only the height scales: line height is leading, so widening the cell would
  // stretch the grid horizontally and break column alignment.
  const lineHeight =
    typeof input.lineHeight === "number" &&
    Number.isFinite(input.lineHeight) &&
    input.lineHeight > 0
      ? input.lineHeight
      : 1;
  return {
    cellWidth: snapCellMetric(input.measuredTextWidth / textLength, input.roundToNearestPixel),
    cellHeight: snapCellMetric(input.measuredTextHeight * lineHeight, input.roundToNearestPixel),
  };
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

export function resolveTerminalCursorOffset(
  input: TerminalCursorOffsetInput,
): TerminalCursorOffset {
  return {
    x: input.cursorCol * input.metrics.cellWidth,
    y: input.cursorRow * input.metrics.cellHeight,
  };
}

function snapCellMetric(value: number, roundToNearestPixel: (value: number) => number): number {
  return Math.max(1, roundToNearestPixel(value));
}

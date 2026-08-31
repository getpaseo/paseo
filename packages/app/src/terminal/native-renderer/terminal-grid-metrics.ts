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

export interface TerminalCustomGlyphCellTransformInput {
  cellOffset: number;
  cellWidth: number;
  cellHeight: number;
}

export interface TerminalWideRunLetterSpacingInput {
  cellWidth: number;
  wideAdvance: number;
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
  return {
    cellWidth: snapCellMetric(input.measuredTextWidth / textLength, input.roundToNearestPixel),
    cellHeight: snapCellMetric(input.measuredTextHeight, input.roundToNearestPixel),
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

// A double-width cell owns two columns, but the font that supplies CJK glyphs
// advances by its own em rather than by two monospace cells. Drawing a whole run
// as one Text therefore walks the glyphs off the grid, and the drift only snaps
// back where a style change starts the next run. Pad each glyph back to two
// columns instead.
export function resolveTerminalWideRunLetterSpacing(
  input: TerminalWideRunLetterSpacingInput,
): number {
  if (input.wideAdvance <= 0) {
    return 0;
  }
  return Math.max(0, input.cellWidth * 2 - input.wideAdvance);
}

function snapCellMetric(value: number, roundToNearestPixel: (value: number) => number): number {
  return Math.max(1, roundToNearestPixel(value));
}

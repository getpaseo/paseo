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

export interface TerminalTextLetterSpacingInput {
  measuredTextWidth: number;
  measureTextLength: number;
  cellWidth: number;
  cellsPerGlyph: 1 | 2;
}

// Cells are snapped to the pixel grid but glyphs advance by their font's natural width, so a run
// of N glyphs ends N * (cells * cellWidth - advance) away from its cells and the cursor. The
// letter spacing makes up that difference per glyph.
export function resolveTerminalTextLetterSpacing(input: TerminalTextLetterSpacingInput): number {
  const textLength = Math.max(1, input.measureTextLength);
  return input.cellsPerGlyph * input.cellWidth - input.measuredTextWidth / textLength;
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

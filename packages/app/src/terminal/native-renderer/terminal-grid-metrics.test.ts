import { describe, expect, it } from "vitest";

import {
  resolveTerminalCustomGlyphCellTransform,
  resolveTerminalGridMetricsMeasurement,
  resolveMeasuredTerminalCellMetrics,
  resolveTerminalCursorOffset,
} from "./terminal-grid-metrics";

describe("native terminal grid metrics", () => {
  it("places each normalized custom glyph in run viewport coordinates", () => {
    expect(
      resolveTerminalCustomGlyphCellTransform({
        cellOffset: 57,
        cellWidth: 7.4,
        cellHeight: 16.2,
      }),
    ).toBe("matrix(7.4 0 0 16.2 421.8 0)");
  });

  it("preserves fractional measured cell width for horizontal layout", () => {
    expect(
      resolveMeasuredTerminalCellMetrics({
        measuredTextWidth: 72.246,
        measuredTextHeight: 16.2,
        measureTextLength: 10,
        roundToNearestPixel: (value) => value,
      }),
    ).toEqual({
      cellWidth: 7.2246,
      cellHeight: 16.2,
    });
  });

  it("scales cell height by line height", () => {
    expect(
      resolveMeasuredTerminalCellMetrics({
        measuredTextWidth: 70,
        measuredTextHeight: 16,
        measureTextLength: 10,
        lineHeight: 1.5,
        roundToNearestPixel: (value) => value,
      }),
    ).toEqual({
      cellWidth: 7,
      cellHeight: 24,
    });
  });

  // Line height is leading, not tracking: widening the cell would desync every
  // column from the glyph advance and smear the grid horizontally.
  it("leaves cell width untouched when line height changes", () => {
    const base = {
      measuredTextWidth: 70,
      measuredTextHeight: 16,
      measureTextLength: 10,
      roundToNearestPixel: (value: number) => value,
    };
    const tight = resolveMeasuredTerminalCellMetrics({ ...base, lineHeight: 1 });
    const loose = resolveMeasuredTerminalCellMetrics({ ...base, lineHeight: 1.8 });
    expect(loose.cellWidth).toBe(tight.cellWidth);
    expect(loose.cellHeight).toBeGreaterThan(tight.cellHeight);
  });

  it.each([undefined, 0, -1, Number.NaN])(
    "treats %s line height as 1.0 rather than collapsing the cell",
    (lineHeight) => {
      expect(
        resolveMeasuredTerminalCellMetrics({
          measuredTextWidth: 70,
          measuredTextHeight: 16,
          measureTextLength: 10,
          lineHeight,
          roundToNearestPixel: (value) => value,
        }).cellHeight,
      ).toBe(16);
    },
  );

  it.each([1, 2, 2.75, 3, 3.5])(
    "aligns cells to the physical pixel grid at density %s",
    (density) => {
      const metrics = resolveMeasuredTerminalCellMetrics({
        measuredTextWidth: 72.246,
        measuredTextHeight: 16.2,
        measureTextLength: 10,
        roundToNearestPixel: (value) => Math.round(value * density) / density,
      });

      expect(metrics.cellWidth * density).toBeCloseTo(Math.round(metrics.cellWidth * density), 10);
      expect(metrics.cellHeight * density).toBeCloseTo(
        Math.round(metrics.cellHeight * density),
        10,
      );
    },
  );

  it("positions the cursor with the measured fractional cell width", () => {
    expect(
      resolveTerminalCursorOffset({
        cursorCol: 80,
        cursorRow: 3,
        metrics: { cellWidth: 7.2246, cellHeight: 16 },
      }),
    ).toEqual({
      x: 577.968,
      y: 48,
    });
  });

  it("emits measured metrics once until the measurement changes", () => {
    const measured = { cellWidth: 7.2, cellHeight: 16 };

    expect(resolveTerminalGridMetricsMeasurement(null, measured)).toEqual(measured);
    expect(resolveTerminalGridMetricsMeasurement(measured, measured)).toBeNull();
    expect(
      resolveTerminalGridMetricsMeasurement(measured, {
        cellWidth: 7.3,
        cellHeight: 16,
      }),
    ).toEqual({ cellWidth: 7.3, cellHeight: 16 });
  });
});

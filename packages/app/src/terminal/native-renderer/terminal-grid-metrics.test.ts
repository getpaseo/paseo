import { describe, expect, it } from "vitest";

import {
  resolveMeasuredTerminalCellMetrics,
  resolveTerminalCursorOffset,
} from "./terminal-grid-metrics";

describe("native terminal grid metrics", () => {
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
      cellHeight: 17,
    });
  });

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
});

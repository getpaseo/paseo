import { describe, expect, test } from "vitest";

import { resolveTerminalGridProjection } from "./terminal-grid-projection";

describe("terminal grid projection", () => {
  test("shows the tail when a desktop-sized terminal finishes at the bottom on phone", () => {
    expect(
      resolveTerminalGridProjection({
        gridRows: 62,
        gridCols: 204,
        cursor: { row: 61, col: 2 },
        viewportWidth: 480,
        viewportHeight: 656,
        cellWidth: 10,
        cellHeight: 16,
      }),
    ).toEqual({
      firstRow: 21,
      visibleRows: 41,
      firstCol: 0,
      visibleCols: 48,
      cursorRow: 40,
      cursorCol: 2,
    });
  });

  test("shows the top when clear leaves the prompt near the top of a desktop-sized terminal", () => {
    expect(
      resolveTerminalGridProjection({
        gridRows: 62,
        gridCols: 204,
        cursor: { row: 1, col: 2 },
        viewportWidth: 480,
        viewportHeight: 656,
        cellWidth: 10,
        cellHeight: 16,
      }),
    ).toEqual({
      firstRow: 0,
      visibleRows: 41,
      firstCol: 0,
      visibleCols: 48,
      cursorRow: 1,
      cursorCol: 2,
    });
  });

  test("does not crop a terminal grid that already fits the renderer viewport", () => {
    expect(
      resolveTerminalGridProjection({
        gridRows: 24,
        gridCols: 80,
        cursor: { row: 23, col: 2 },
        viewportWidth: 900,
        viewportHeight: 500,
        cellWidth: 10,
        cellHeight: 16,
      }),
    ).toEqual({
      firstRow: 0,
      visibleRows: 24,
      firstCol: 0,
      visibleCols: 80,
      cursorRow: 23,
      cursorCol: 2,
    });
  });
});

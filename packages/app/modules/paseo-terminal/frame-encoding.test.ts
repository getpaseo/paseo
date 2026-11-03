import { describe, expect, test } from "vitest";

import { encodeTerminalFrame } from "./frame-encoding";

describe("encodeTerminalFrame", () => {
  test("puts cells and styles before text, so text may contain separators", () => {
    const native = encodeTerminalFrame({
      columns: 10,
      rows: [
        {
          text: "안a;b,",
          cells: [1, 2, 1, 1, 1, 1, 1, 1, 1, 1],
          styles: [3, 0xffe5e5e5, 0, 0, 3, 0xffff0000, 0, 1],
        },
        { text: "", cells: [], styles: [] },
      ],
      cursor: { row: 1, col: 0 },
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    });

    expect(native).toEqual({
      columns: 10,
      rows: ["1,2,1,1,1,1,1,1,1,1;3,4293256677,0,0,3,4294901760,0,1;안a;b,", ";;"],
      cursor: { row: 1, col: 0 },
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    });
  });

  test("leaves out a missing cursor and selection instead of sending null", () => {
    const native = encodeTerminalFrame({ columns: 1, rows: [], cursor: null, selection: null });

    expect(Object.keys(native)).toEqual(["columns", "rows"]);
  });
});

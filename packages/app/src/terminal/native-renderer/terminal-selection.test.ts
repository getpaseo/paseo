import { describe, expect, it } from "vitest";

import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import type {
  NativeHeadlessTerminal,
  TerminalBufferBounds,
  TerminalBufferWindowInput,
  TerminalCellRow,
} from "./headless-terminal-state";
import {
  copyTerminalSelection,
  createTerminalSelectionModel,
  extractTerminalSelectedText,
  hitTestTerminalSelectionCell,
  normalizeTerminalSelection,
  resolveTerminalWordSelection,
  resolveTerminalSelectionRects,
} from "./terminal-selection";

function terminalLines(input: { startLine: number; lineCount: number }): string {
  return Array.from(
    { length: input.lineCount },
    (_, index) => `line-${input.startLine + index}\r\n`,
  ).join("");
}

function rowWithText(
  terminal: ReturnType<typeof createNativeHeadlessTerminal>,
  text: string,
): number {
  const bounds = terminal.getBufferBounds();
  const window = terminal.getBufferWindow({
    startRow: bounds.oldestRow,
    rowCount: bounds.newestRow - bounds.oldestRow + 1,
  });
  const rowOffset = window.rows.findIndex((row) => {
    const rowText = row
      .map((cell) => cell.char)
      .join("")
      .trimEnd();
    return rowText === text;
  });
  if (rowOffset < 0) {
    throw new Error(`missing terminal row: ${text}`);
  }
  return window.startRow + rowOffset;
}

// Orphan placeholders (a width-0 cell not preceded by a width-2 glyph, e.g.
// from a snapshot clipped mid-glyph) never occur in a live xterm buffer, so
// those cases drive the selection logic with a hand-built row window.
function terminalFromRows(rows: TerminalCellRow[]): NativeHeadlessTerminal {
  const lastRow = rows.length - 1;
  const bounds: TerminalBufferBounds = {
    rows: rows.length,
    cols: Math.max(...rows.map((row) => row.length)),
    oldestRow: 0,
    newestRow: lastRow,
    coordinateEpoch: 0,
    currentViewport: { firstRow: 0, lastRow },
    bottomViewport: { firstRow: 0, lastRow },
    cursorRow: 0,
    cursorCol: 0,
  };
  const terminal: Pick<NativeHeadlessTerminal, "getBufferBounds" | "getBufferWindow"> = {
    getBufferBounds: () => bounds,
    getBufferWindow: (input: TerminalBufferWindowInput) => ({
      startRow: input.startRow,
      rows: rows.slice(input.startRow, input.startRow + input.rowCount),
      wrappedRows: rows.map(() => false),
    }),
  };
  return terminal as NativeHeadlessTerminal;
}

describe("native terminal selection", () => {
  it("expands a long-press coordinate to the whole terminal word", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 32, scrollbackLines: 20 });
    await terminal.write("before PASEO_TARGET after\r\n");
    const row = rowWithText(terminal, "before PASEO_TARGET after");

    const selection = resolveTerminalWordSelection({
      terminal,
      coordinate: { row, col: 12 },
    });

    expect({
      selection,
      text: extractTerminalSelectedText({ terminal, selection }),
    }).toEqual({
      selection: {
        start: { row, col: 7 },
        end: { row, col: 18 },
        coordinateEpoch: terminal.getBufferBounds().coordinateEpoch,
      },
      text: "PASEO_TARGET",
    });
  });

  it("expands a long-press across a wide glyph without stopping at its placeholder", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 32, scrollbackLines: 20 });
    await terminal.write("before 中文 after\r\n");
    // The raw char join includes each wide glyph's width-0 placeholder blank.
    const row = rowWithText(terminal, "before 中 文  after");
    const bounds = terminal.getBufferBounds();

    // Long-press on 文 (col 9): the placeholder columns (8 and 10) are part of
    // the glyphs, not word boundaries, so the whole CJK word is selected.
    const selection = resolveTerminalWordSelection({
      terminal,
      coordinate: { row, col: 9 },
    });

    expect({
      selection,
      text: extractTerminalSelectedText({ terminal, selection }),
    }).toEqual({
      selection: {
        start: { row, col: 7 },
        end: { row, col: 10 },
        coordinateEpoch: bounds.coordinateEpoch,
      },
      text: "中文",
    });
  });

  it("resolves a long-press on a wide glyph's placeholder column to the glyph", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 32, scrollbackLines: 20 });
    await terminal.write("before 中文 after\r\n");
    const row = rowWithText(terminal, "before 中 文  after");
    const bounds = terminal.getBufferBounds();

    // Col 8 is the placeholder half of 中 — the press belongs to the glyph.
    const selection = resolveTerminalWordSelection({
      terminal,
      coordinate: { row, col: 8 },
    });

    expect({
      selection,
      text: extractTerminalSelectedText({ terminal, selection }),
    }).toEqual({
      selection: {
        start: { row, col: 7 },
        end: { row, col: 10 },
        coordinateEpoch: bounds.coordinateEpoch,
      },
      text: "中文",
    });
  });

  it("maps screen coordinates through the current visible window", () => {
    expect(
      hitTestTerminalSelectionCell({
        point: { x: 18, y: 25 },
        metrics: { cellWidth: 8, cellHeight: 10 },
        viewport: { firstRow: 120, rows: 4, cols: 80 },
      }),
    ).toEqual({ row: 122, col: 2 });
  });

  it("maps screen coordinates through a scrolled visible window", () => {
    expect(
      hitTestTerminalSelectionCell({
        point: { x: 0, y: 0 },
        metrics: { cellWidth: 8, cellHeight: 10 },
        viewport: { firstRow: 250, rows: 4, cols: 80 },
      }),
    ).toEqual({ row: 250, col: 0 });

    expect(
      hitTestTerminalSelectionCell({
        point: { x: 24, y: 35 },
        metrics: { cellWidth: 8, cellHeight: 10 },
        viewport: { firstRow: 250, rows: 4, cols: 80 },
      }),
    ).toEqual({ row: 253, col: 3 });
  });

  it("normalizes reverse selections across rows", () => {
    expect(
      normalizeTerminalSelection({
        anchor: { row: 12, col: 9 },
        focus: { row: 10, col: 4 },
        coordinateEpoch: 7,
      }),
    ).toEqual({
      start: { row: 10, col: 4 },
      end: { row: 12, col: 9 },
      coordinateEpoch: 7,
    });
  });

  it("renders selected cells only inside the current viewport", () => {
    const selection = normalizeTerminalSelection({
      anchor: { row: 11, col: 2 },
      focus: { row: 13, col: 4 },
      coordinateEpoch: 3,
    });

    expect(
      resolveTerminalSelectionRects({
        selection,
        viewport: { firstRow: 12, rows: 3, cols: 10 },
        metrics: { cellWidth: 8, cellHeight: 10 },
      }),
    ).toEqual([
      { key: "12:0:9", x: 0, y: 0, width: 80, height: 10 },
      { key: "13:0:4", x: 0, y: 10, width: 40, height: 10 },
    ]);
  });

  it("extracts only selected terminal cells with row breaks", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 16, scrollbackLines: 20 });
    await terminal.write("alpha beta\r\ngamma delta\r\n");
    const bounds = terminal.getBufferBounds();
    const alphaRow = rowWithText(terminal, "alpha beta");
    const gammaRow = rowWithText(terminal, "gamma delta");

    expect(
      extractTerminalSelectedText({
        terminal,
        selection: {
          start: { row: alphaRow, col: 6 },
          end: { row: gammaRow, col: 4 },
          coordinateEpoch: bounds.coordinateEpoch,
        },
      }),
    ).toEqual("beta\ngamma");
  });

  it("copies wide-glyph rows without the placeholder column", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 16, scrollbackLines: 20 });
    await terminal.write("A界B\r\n");
    const bounds = terminal.getBufferBounds();
    // The raw char join includes the width-0 placeholder blank after 界.
    const row = rowWithText(terminal, "A界 B");

    expect(
      extractTerminalSelectedText({
        terminal,
        selection: {
          start: { row, col: 0 },
          end: { row, col: 3 },
          coordinateEpoch: bounds.coordinateEpoch,
        },
      }),
    ).toBe("A界B");
  });

  it("copies the whole glyph when a drag starts on its placeholder half", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 16, scrollbackLines: 20 });
    await terminal.write("A界B\r\n");
    const bounds = terminal.getBufferBounds();
    // The raw char join includes the width-0 placeholder blank after 界.
    const row = rowWithText(terminal, "A界 B");

    // Col 2 is the placeholder half of 界: the drag visibly selects 界B, so
    // the copy must include the glyph.
    expect(
      extractTerminalSelectedText({
        terminal,
        selection: {
          start: { row, col: 2 },
          end: { row, col: 3 },
          coordinateEpoch: bounds.coordinateEpoch,
        },
      }),
    ).toBe("界B");
  });

  it("does not pull the previous cell into a drag that starts on an orphan placeholder", () => {
    const terminal = terminalFromRows([
      [
        { char: "A", width: 1 },
        { char: " ", width: 0 },
        { char: "B", width: 1 },
      ],
    ]);
    const bounds = terminal.getBufferBounds();

    // The renderer skips the orphan placeholder, so the visible selection
    // from col 1 is just B; copying must not add the preceding A.
    expect(
      extractTerminalSelectedText({
        terminal,
        selection: {
          start: { row: 0, col: 1 },
          end: { row: 0, col: 2 },
          coordinateEpoch: bounds.coordinateEpoch,
        },
      }),
    ).toBe("B");
  });

  it("treats a long-press on an orphan placeholder as a blank cell", () => {
    const terminal = terminalFromRows([
      [
        { char: "a", width: 1 },
        { char: "b", width: 1 },
        { char: " ", width: 0 },
        { char: "c", width: 1 },
      ],
    ]);
    const bounds = terminal.getBufferBounds();

    // The orphan belongs to no glyph, so the press must not resolve to the
    // preceding word.
    expect(resolveTerminalWordSelection({ terminal, coordinate: { row: 0, col: 2 } })).toEqual({
      start: { row: 0, col: 2 },
      end: { row: 0, col: 2 },
      coordinateEpoch: bounds.coordinateEpoch,
    });
  });

  it("copies soft-wrapped rows without fake line breaks", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 4, scrollbackLines: 20 });
    await terminal.write("abcdef");
    const bounds = terminal.getBufferBounds();
    const firstRow = rowWithText(terminal, "abcd");
    const secondRow = rowWithText(terminal, "ef");

    expect(
      extractTerminalSelectedText({
        terminal,
        selection: {
          start: { row: firstRow, col: 0 },
          end: { row: secondRow, col: 1 },
          coordinateEpoch: bounds.coordinateEpoch,
        },
      }),
    ).toEqual("abcdef");
  });

  it("invalidates selection when buffer coordinates become unsafe", () => {
    const selection = createTerminalSelectionModel();

    selection.begin({
      coordinate: { row: 4, col: 2 },
      bounds: { oldestRow: 0, newestRow: 10, coordinateEpoch: 1 },
    });
    selection.update({
      coordinate: { row: 5, col: 6 },
      bounds: { oldestRow: 0, newestRow: 10, coordinateEpoch: 1 },
    });

    expect(selection.sync({ bounds: { oldestRow: 0, newestRow: 10, coordinateEpoch: 2 } })).toEqual(
      {
        range: null,
      },
    );
  });

  it("invalidates a selection when a near-full burst evicts scrollback", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 3, cols: 16, scrollbackLines: 10 });
    await terminal.write(terminalLines({ startLine: 0, lineCount: 6 }));
    const selection = createTerminalSelectionModel();
    const before = terminal.getBufferBounds();
    selection.begin({
      coordinate: { row: before.oldestRow, col: 0 },
      bounds: before,
    });
    selection.update({
      coordinate: { row: before.oldestRow, col: 4 },
      bounds: before,
    });

    await terminal.write(terminalLines({ startLine: 6, lineCount: 20 }));
    const after = terminal.getBufferBounds();

    expect({
      selectedRowsEvicted: after.oldestRow > before.oldestRow,
      sameCoordinateSpace: after.coordinateEpoch === before.coordinateEpoch,
      selection: selection.sync({ bounds: after }),
    }).toEqual({
      selectedRowsEvicted: true,
      sameCoordinateSpace: true,
      selection: { range: null },
    });
  });

  it("keeps a selection when saturated-buffer output does not evict rows", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 3, cols: 16, scrollbackLines: 2 });
    await terminal.write(terminalLines({ startLine: 0, lineCount: 8 }));
    const selection = createTerminalSelectionModel();
    const before = terminal.getBufferBounds();
    selection.begin({ coordinate: { row: 1, col: 0 }, bounds: before });
    selection.update({ coordinate: { row: 1, col: 3 }, bounds: before });

    await terminal.write("tail");

    expect(selection.sync({ bounds: terminal.getBufferBounds() }).range).not.toBeNull();
  });

  it("keeps and copies selected rows until those rows are evicted", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 3, cols: 16, scrollbackLines: 10 });
    await terminal.write(terminalLines({ startLine: 0, lineCount: 13 }));
    const selection = createTerminalSelectionModel();
    const selectedRow = rowWithText(terminal, "line-9");
    const before = terminal.getBufferBounds();
    selection.begin({ coordinate: { row: selectedRow, col: 0 }, bounds: before });
    selection.update({ coordinate: { row: selectedRow, col: 5 }, bounds: before });

    await terminal.write(terminalLines({ startLine: 13, lineCount: 3 }));
    const retained = selection.sync({ bounds: terminal.getBufferBounds() }).range;

    expect({
      retained,
      copied: extractTerminalSelectedText({ terminal, selection: retained }),
    }).toEqual({
      retained: {
        start: { row: selectedRow, col: 0 },
        end: { row: selectedRow, col: 5 },
        coordinateEpoch: before.coordinateEpoch,
      },
      copied: "line-9",
    });

    await terminal.write(terminalLines({ startLine: 16, lineCount: 10 }));

    expect(selection.sync({ bounds: terminal.getBufferBounds() })).toEqual({ range: null });
  });

  it("copies exactly the selected known visible text", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 16, scrollbackLines: 20 });
    await terminal.write("COPY_OK_123\r\n");
    const bounds = terminal.getBufferBounds();
    const copyRow = rowWithText(terminal, "COPY_OK_123");
    const copied: string[] = [];

    await copyTerminalSelection({
      terminal,
      selection: {
        start: { row: copyRow, col: 0 },
        end: { row: copyRow, col: 10 },
        coordinateEpoch: bounds.coordinateEpoch,
      },
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        },
      },
    });

    expect(copied).toEqual(["COPY_OK_123"]);
  });

  it("copies custom-drawn Claude glyphs as their original Unicode text", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 32, scrollbackLines: 20 });
    const art = "╭─ Claude ─╮\r\n│ ▐▛███▜▌ │\r\n╰──────────╯";
    await terminal.write(art);
    const bounds = terminal.getBufferBounds();
    const firstRow = rowWithText(terminal, "╭─ Claude ─╮");
    const lastRow = rowWithText(terminal, "╰──────────╯");

    expect(
      extractTerminalSelectedText({
        terminal,
        selection: {
          start: { row: firstRow, col: 0 },
          end: { row: lastRow, col: 11 },
          coordinateEpoch: bounds.coordinateEpoch,
        },
      }),
    ).toBe(art.replaceAll("\r", ""));
  });

  it("copies known text after it has scrolled into retained history", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 16, scrollbackLines: 20 });
    await terminal.write("KEEP_THIS_LINE\r\n");
    await terminal.write(Array.from({ length: 12 }, (_, index) => `filler-${index}\r\n`).join(""));
    const bounds = terminal.getBufferBounds();
    const targetRow = rowWithText(terminal, "KEEP_THIS_LINE");
    expect(targetRow).toBeGreaterThanOrEqual(bounds.oldestRow);
    expect(targetRow).toBeLessThanOrEqual(bounds.newestRow);

    const copied: string[] = [];
    await copyTerminalSelection({
      terminal,
      selection: {
        start: { row: targetRow, col: 0 },
        end: { row: targetRow, col: 13 },
        coordinateEpoch: bounds.coordinateEpoch,
      },
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        },
      },
    });

    expect(copied).toEqual(["KEEP_THIS_LINE"]);
  });

  it("does not write clipboard when there is no selection", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 16, scrollbackLines: 20 });
    await terminal.write("copy target\r\n");
    const copied: string[] = [];

    await copyTerminalSelection({
      terminal,
      selection: null,
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        },
      },
    });

    expect(copied).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import {
  copyTerminalSelection,
  createTerminalSelectionModel,
  extractTerminalSelectedText,
  hitTestTerminalSelectionCell,
  normalizeTerminalSelection,
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

describe("native terminal selection", () => {
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
      saturated: after.newestRow === 12,
      epochChanged: after.coordinateEpoch > before.coordinateEpoch,
      selection: selection.sync({ bounds: after }),
    }).toEqual({
      saturated: true,
      epochChanged: true,
      selection: { range: null },
    });
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

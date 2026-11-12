import { describe, expect, test } from "vitest";

import { createNativeHeadlessTerminal, type TerminalCellRow } from "./headless-terminal-state";
import { createNativeTerminalBenchmarkPayload } from "./native-terminal-benchmark-payload";

const COLS = 80;

function rowText(row: TerminalCellRow): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

function expectedBenchmarkLine(index: number): string {
  const label = `line ${index.toString().padStart(6, "0")} `;
  const body = "abcdefghijklmnopqrstuvwxyz0123456789 ".repeat(4);
  return (label + body).slice(0, COLS - 1);
}

describe("native headless terminal state", () => {
  test("routes alternate-screen finger scrolling to the application's cursor keys", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS });
    const scroll = { direction: "up" as const, rows: 2, column: 4, row: 3, x: 24, y: 40 };
    expect(terminal.getScrollInput(scroll)).toBeNull();

    await terminal.write("\x1b[?1049h\x1b[?1h");
    const bounds = terminal.getBufferBounds();
    expect(bounds.oldestRow).toBe(bounds.bottomViewport.firstRow);
    expect(terminal.getScrollInput(scroll)).toBe("\x1bOA\x1bOA");
    expect(terminal.getScrollInput({ ...scroll, direction: "down", rows: 1 })).toBe("\x1bOB");

    await terminal.write("\x1b[?1l");
    expect(terminal.getScrollInput({ ...scroll, rows: 1 })).toBe("\x1b[A");
    await terminal.write("\x1b[?1049l");
    expect(terminal.getScrollInput(scroll)).toBeNull();
    terminal.dispose();
  });

  test.each([1000, 1002, 1003])(
    "routes finger scrolling through mouse tracking mode %i",
    async (mode) => {
      const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS });
      const scroll = { direction: "up" as const, rows: 2, column: 4, row: 3, x: 24, y: 40 };
      await terminal.write(`\x1b[?1049h\x1b[?${mode}h\x1b[?1006h`);
      expect(terminal.getScrollInput(scroll)).toBe("\x1b[<64;4;3M\x1b[<64;4;3M");
      expect(terminal.getScrollInput({ ...scroll, direction: "down", rows: 1 })).toBe(
        "\x1b[<65;4;3M",
      );

      await terminal.write(`\x1b[?${mode}l`);
      expect(terminal.getScrollInput({ ...scroll, rows: 1 })).toBe("\x1b[A");
      terminal.dispose();
    },
  );

  test("keeps xterm's legacy and pixel mouse encodings for finger scroll input", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS });
    const scroll = { direction: "up" as const, rows: 1, column: 4, row: 3, x: 24, y: 40 };
    await terminal.write("\x1b[?1000h");
    expect(terminal.getScrollInput(scroll)).toBe("\x1b[M`$#");
    await terminal.write("\x1b[?1006h\x1b[?1016h");
    expect(terminal.getScrollInput(scroll)).toBe("\x1b[<64;24;40M");
    terminal.reset();
    expect(terminal.getScrollInput(scroll)).toBeNull();
    terminal.dispose();
  });

  test("exposes application cursor key mode from headless xterm", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS });

    expect(terminal.getInputModeState()).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    await terminal.write("\x1b[?1h");
    expect(terminal.getInputModeState()).toEqual({
      applicationCursorKeys: true,
      bracketedPaste: false,
    });
    await terminal.write("\x1b[?1l");
    expect(terminal.getInputModeState()).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
  });

  test("exposes bracketed paste mode from headless xterm", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS });

    expect(terminal.getInputModeState()).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    await terminal.write("\x1b[?2004h");
    expect(terminal.getInputModeState()).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: true,
    });
    await terminal.write("\x1b[?2004l");
    expect(terminal.getInputModeState()).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
  });

  test("reads a scrollback window from the active buffer without extracting full scrollback", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS, scrollbackLines: 100 });

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 80, cols: COLS }),
    );
    const window = terminal.getBufferWindow({ startRow: 70, rowCount: 3 });

    expect({
      startRow: window.startRow,
      rows: window.rows.map(rowText),
    }).toEqual({
      startRow: 70,
      rows: [expectedBenchmarkLine(70), expectedBenchmarkLine(71), expectedBenchmarkLine(72)],
    });
  });

  test("keeps buffer coordinates stable across append-only output before eviction", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS, scrollbackLines: 100 });

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 5, cols: COLS }),
    );
    const before = terminal.getBufferBounds();
    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 5, lineCount: 5, cols: COLS }),
    );
    const after = terminal.getBufferBounds();

    expect({
      beforeEpoch: before.coordinateEpoch,
      afterEpoch: after.coordinateEpoch,
      grew: after.newestRow > before.newestRow,
    }).toEqual({
      beforeEpoch: before.coordinateEpoch,
      afterEpoch: before.coordinateEpoch,
      grew: true,
    });
  });

  test("advances the oldest stable coordinate when scrollback rows are evicted", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 3, cols: COLS, scrollbackLines: 2 });

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 8, cols: COLS }),
    );
    const before = terminal.getBufferBounds();
    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 8, lineCount: 4, cols: COLS }),
    );
    const after = terminal.getBufferBounds();

    expect({
      sameRetainedRowCount:
        after.newestRow - after.oldestRow === before.newestRow - before.oldestRow,
      oldestRowAdvanced: after.oldestRow > before.oldestRow,
      sameCoordinateSpace: after.coordinateEpoch === before.coordinateEpoch,
    }).toEqual({
      sameRetainedRowCount: true,
      oldestRowAdvanced: true,
      sameCoordinateSpace: true,
    });
  });

  test("keeps buffer coordinates stable for writes that do not evict a saturated buffer", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 3, cols: COLS, scrollbackLines: 2 });

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 8, cols: COLS }),
    );
    const before = terminal.getBufferBounds();
    await terminal.write("still on the current row");
    const after = terminal.getBufferBounds();

    expect(after.coordinateEpoch).toEqual(before.coordinateEpoch);
  });

  test("changes buffer coordinate epoch on reset", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS, scrollbackLines: 100 });

    await terminal.write("before reset\r\n");
    const before = terminal.getBufferBounds();
    terminal.reset();
    await terminal.write("after reset\r\n");
    const after = terminal.getBufferBounds();

    expect(after.coordinateEpoch > before.coordinateEpoch).toEqual(true);
  });

  test("preserves xterm's authoritative wide-cell metadata", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 2, cols: 8 });

    await terminal.write("A界B");
    const [row] = terminal.getBufferWindow({ startRow: 0, rowCount: 1 }).rows;

    expect(row.slice(0, 4).map((cell) => ({ char: cell.char, width: cell.width }))).toEqual([
      { char: "A", width: 1 },
      { char: "界", width: 2 },
      { char: " ", width: 0 },
      { char: "B", width: 1 },
    ]);
  });

  // Apple Color Emoji and Noto Color Emoji are two cells wide. The native
  // renderer scales a cluster to its column slot, so a one-column emoji
  // renders at half size. Each emoji cluster must occupy one wide cell.
  test.each([
    ["presentation emoji", "😀"],
    ["thumbs up", "👍"],
    ["check mark", "✅"],
    ["VS16 heart", "❤️"],
    ["skin-tone modifier", "👋🏽"],
    ["regional-indicator flag", "🇰🇷"],
    ["ZWJ family", "👨‍👩‍👧"],
    ["ZWJ technologist", "👩‍💻"],
  ])("gives a %s cluster one two-column cell", async (_name, cluster) => {
    const terminal = createNativeHeadlessTerminal({ rows: 2, cols: 12 });

    await terminal.write(`A${cluster}B`);
    const [row] = terminal.getBufferWindow({ startRow: 0, rowCount: 1 }).rows;

    expect(row.slice(0, 4).map((cell) => ({ char: cell.char, width: cell.width }))).toEqual([
      { char: "A", width: 1 },
      { char: cluster, width: 2 },
      { char: " ", width: 0 },
      { char: "B", width: 1 },
    ]);
    expect(terminal.getViewportState().cursor.col).toBe(4);
  });

  // A host without grapheme widths answers cursor reports and replays with
  // xterm's default table. The native buffer matches it so the cursor lands
  // where the host put it.
  test("measures with xterm's default table for hosts without grapheme widths", async () => {
    const terminal = createNativeHeadlessTerminal({
      rows: 2,
      cols: 12,
      characterWidths: "legacy",
    });

    await terminal.write("A😀B");
    const [row] = terminal.getBufferWindow({ startRow: 0, rowCount: 1 }).rows;

    expect(row.slice(0, 3).map((cell) => ({ char: cell.char, width: cell.width }))).toEqual([
      { char: "A", width: 1 },
      { char: "😀", width: 1 },
      { char: "B", width: 1 },
    ]);
    expect(terminal.getViewportState().cursor.col).toBe(3);
  });
});

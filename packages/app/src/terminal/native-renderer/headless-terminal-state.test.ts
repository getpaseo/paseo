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

  describe("OSC 52 clipboard", () => {
    const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

    function createWithOsc52() {
      const copies: string[] = [];
      const terminal = createNativeHeadlessTerminal({
        rows: 5,
        cols: COLS,
        onOsc52: (text) => copies.push(text),
      });
      return { terminal, copies };
    }

    test("copies BEL-terminated text", async () => {
      const { terminal, copies } = createWithOsc52();
      await terminal.write(`\x1b]52;c;${base64("hello")}\x07`);
      expect(copies).toEqual(["hello"]);
    });

    test("copies ST-terminated text", async () => {
      const { terminal, copies } = createWithOsc52();
      await terminal.write(`\x1b]52;c;${base64("hello")}\x1b\\`);
      expect(copies).toEqual(["hello"]);
    });

    test("copies a sequence split across writes", async () => {
      const { terminal, copies } = createWithOsc52();
      const sequence = `\x1b]52;c;${base64("split across chunks")}\x07`;
      const midpoint = Math.floor(sequence.length / 2);
      await terminal.write(sequence.slice(0, midpoint));
      await terminal.write(sequence.slice(midpoint));
      expect(copies).toEqual(["split across chunks"]);
    });

    test("copies non-ASCII text as UTF-8", async () => {
      const { terminal, copies } = createWithOsc52();
      await terminal.write(`\x1b]52;c;${base64("한국어 테스트")}\x07`);
      expect(copies).toEqual(["한국어 테스트"]);
    });

    test("clears the clipboard on an empty payload", async () => {
      const { terminal, copies } = createWithOsc52();
      await terminal.write("\x1b]52;c;\x07");
      expect(copies).toEqual([""]);
    });

    test("ignores primary selection, read queries, and malformed payloads", async () => {
      const { terminal, copies } = createWithOsc52();
      await terminal.write(`\x1b]52;p;${base64("nope")}\x07`);
      await terminal.write("\x1b]52;c;?\x07");
      await terminal.write("\x1b]52;c;not!base64\x07");
      await terminal.write("\x1b]52;c;abc\x07"); // length not a multiple of 4
      expect(copies).toEqual([]);
    });

    test("leaves no cells behind", async () => {
      const { terminal, copies } = createWithOsc52();
      await terminal.write(`before\x1b]52;c;${base64("x")}\x07after`);
      expect(copies).toEqual(["x"]);
      const [row] = terminal.getBufferWindow({ startRow: 0, rowCount: 1 }).rows;
      expect(rowText(row)).toBe("beforeafter");
    });

    test("works without a handler registered", async () => {
      const terminal = createNativeHeadlessTerminal({ rows: 5, cols: COLS });
      await terminal.write(`\x1b]52;c;${base64("dropped")}\x07text`);
      const [row] = terminal.getBufferWindow({ startRow: 0, rowCount: 1 }).rows;
      expect(rowText(row)).toBe("text");
    });
  });
});

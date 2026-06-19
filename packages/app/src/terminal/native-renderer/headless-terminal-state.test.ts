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

  test("changes buffer coordinate epoch when scrollback eviction can shift rows", async () => {
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
      sameNewestRow: after.newestRow === before.newestRow,
      epochChanged: after.coordinateEpoch > before.coordinateEpoch,
    }).toEqual({
      sameNewestRow: true,
      epochChanged: true,
    });
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
});

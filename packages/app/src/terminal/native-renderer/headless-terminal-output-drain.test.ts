import { describe, expect, test } from "vitest";

import {
  createNativeHeadlessTerminal,
  type TerminalCellRow,
  type TerminalViewportState,
} from "./headless-terminal-state";
import { createNativeTerminalBenchmarkPayload } from "./native-terminal-benchmark-payload";
import {
  createNativeTerminalOutputDrain,
  NATIVE_TERMINAL_PARSE_CHUNK_CHARS,
} from "./headless-terminal-output-drain";
import { createNativeTerminalScreenModel, type TerminalScreenState } from "./terminal-screen-model";
import { renderTerminalSnapshotToAnsi } from "../runtime/terminal-snapshot";

const ROWS = 12;
const COLS = 80;

function rowText(row: TerminalViewportState["grid"][number]): string {
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

function createFrameRecorder() {
  const frames: Array<() => void> = [];
  return {
    frames,
    scheduleFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  };
}

function lineCells(line: string, cols: number): TerminalCellRow {
  const cells: TerminalCellRow = [];
  for (let index = 0; index < cols; index += 1) {
    cells.push({ char: line[index] ?? " ", width: 1 });
  }
  return cells;
}

function terminalStateFromLines(input: {
  lines: string[];
  rows: number;
  cols: number;
  cursor: TerminalViewportState["cursor"];
}) {
  const grid: TerminalCellRow[] = [];
  for (let row = 0; row < input.rows; row += 1) {
    grid.push(lineCells(input.lines[row] ?? "", input.cols));
  }
  return {
    rows: input.rows,
    cols: input.cols,
    grid,
    scrollback: [],
    cursor: input.cursor,
  };
}

async function runScheduledWork(input: {
  callbacks: Array<() => void>;
  flush: Promise<void>;
}): Promise<void> {
  while (input.callbacks.length > 0) {
    input.callbacks.shift()?.();
    await Promise.resolve();
  }
  await input.flush;
}

async function benchmarkSnapshot(lineCount: number) {
  const terminal = createNativeHeadlessTerminal({ rows: ROWS, cols: COLS, scrollbackLines: 100 });
  await terminal.write(
    createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount, cols: COLS }),
  );
  return terminal.getState();
}

function createScreenRestorer(
  terminal: ReturnType<typeof createNativeHeadlessTerminal>,
  model: ReturnType<typeof createNativeTerminalScreenModel>,
) {
  const frameRecorder = createFrameRecorder();
  let screen: TerminalScreenState | null = null;
  const drain = createNativeTerminalOutputDrain({
    write: (chunk) => terminal.write(chunk),
    reset: () => terminal.reset(),
    getViewportState: () => {
      screen = model.sync({ visibleRows: ROWS });
      return screen.viewport;
    },
    onPaint: () => {},
    scheduleFrame: frameRecorder.scheduleFrame,
    cancelFrame: frameRecorder.cancelFrame,
  });

  return {
    async restore(snapshot: Awaited<ReturnType<typeof benchmarkSnapshot>>) {
      drain.restoreSnapshot(snapshot);
      await drain.flush();
      frameRecorder.frames[0]?.();
      return screen;
    },
  };
}

describe("native terminal output drain", () => {
  test("drains large bursts without waiting one frame per 2KB parse slice", async () => {
    const writes: string[] = [];
    const parseSamples: Array<{ parsedChars: number; queuedChars: number }> = [];
    const frameRecorder = createFrameRecorder();
    const payload = "x".repeat(NATIVE_TERMINAL_PARSE_CHUNK_CHARS * 2);
    const drain = createNativeTerminalOutputDrain({
      write: async (chunk) => {
        writes.push(chunk);
      },
      reset: () => {},
      getViewportState: () => ({
        rows: 1,
        cols: 1,
        firstRow: 0,
        oldestRow: 0,
        newestRow: 0,
        grid: [[{ char: "x" }]],
        cursor: { row: 0, col: 1 },
      }),
      onPaint: () => {},
      onParse: (sample) => parseSamples.push(sample),
      scheduleFrame: frameRecorder.scheduleFrame,
      cancelFrame: frameRecorder.cancelFrame,
    });

    drain.enqueueText(payload);
    await drain.flush();

    expect(writes.map((write) => write.length)).toEqual([
      NATIVE_TERMINAL_PARSE_CHUNK_CHARS,
      NATIVE_TERMINAL_PARSE_CHUNK_CHARS,
    ]);
    expect(writes.join("")).toBe(payload);
    expect(
      parseSamples.map(({ parsedChars, queuedChars }) => ({ parsedChars, queuedChars })),
    ).toEqual([
      {
        parsedChars: NATIVE_TERMINAL_PARSE_CHUNK_CHARS,
        queuedChars: NATIVE_TERMINAL_PARSE_CHUNK_CHARS,
      },
      { parsedChars: NATIVE_TERMINAL_PARSE_CHUNK_CHARS, queuedChars: 0 },
    ]);
    expect(frameRecorder.frames).toHaveLength(1);
  });

  test("paints the final bottom viewport after a high-output byte burst", async () => {
    const terminal = createNativeHeadlessTerminal({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: 1000,
    });
    const paintedStates: TerminalViewportState[] = [];
    const frameRecorder = createFrameRecorder();
    const drain = createNativeTerminalOutputDrain({
      write: (chunk) => terminal.write(chunk),
      reset: () => terminal.reset(),
      getViewportState: () => terminal.getViewportState(),
      onPaint: (state) => paintedStates.push(state),
      scheduleFrame: frameRecorder.scheduleFrame,
      cancelFrame: frameRecorder.cancelFrame,
    });

    drain.enqueueText(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 250, cols: COLS }),
    );
    await drain.flush();
    frameRecorder.frames[0]?.();

    expect(
      paintedStates.map((state) => ({
        cursor: state.cursor,
        bottomRows: state.grid.slice(-2).map(rowText),
      })),
    ).toEqual([
      {
        cursor: { row: ROWS - 1, col: 0 },
        bottomRows: [expectedBenchmarkLine(249), ""],
      },
    ]);
  });

  test("restores replace old terminal state and discard stale queued output", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 32, scrollbackLines: 100 });
    const scheduledWork: Array<() => void> = [];
    const frameRecorder = createFrameRecorder();
    const drain = createNativeTerminalOutputDrain({
      write: (chunk) => terminal.write(chunk),
      reset: () => terminal.reset(),
      getViewportState: () => terminal.getViewportState(),
      onPaint: () => {},
      scheduleWork: (callback) => scheduledWork.push(callback),
      scheduleFrame: frameRecorder.scheduleFrame,
      cancelFrame: frameRecorder.cancelFrame,
    });
    const restoredSnapshot = terminalStateFromLines({
      rows: 4,
      cols: 32,
      lines: ["restored-one", "restored-two"],
      cursor: { row: 1, col: "restored-two".length },
    });

    await terminal.write("old-one\r\nold-two\r\nold-three\r\n");
    drain.enqueueText("stale-queued\r\n");
    drain.restoreText(renderTerminalSnapshotToAnsi(restoredSnapshot));
    await runScheduledWork({ callbacks: scheduledWork, flush: drain.flush() });

    const state = terminal.getViewportState();
    expect(state.grid.map(rowText)).toEqual(["restored-one", "restored-two", "", ""]);
    expect(state.cursor).toEqual(restoredSnapshot.cursor);
  });

  test("snapshot restore preserves a scrolled viewport anchor while replacing terminal state", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: ROWS, cols: COLS, scrollbackLines: 100 });
    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 30, cols: COLS }),
    );
    const model = createNativeTerminalScreenModel({ terminal });
    const before = model.scrollUp({ rows: 5, visibleRows: ROWS });
    const beforeTopRow = rowText(before.viewport.grid[0] ?? []);

    const screen = await createScreenRestorer(terminal, model).restore(await benchmarkSnapshot(35));

    expect({
      paintedMode: screen?.scroll.mode,
      paintedTopRow: rowText(screen?.viewport.grid[0] ?? []),
      beforeTopRow,
      restoredBottomRows: terminal.getState().grid.slice(-2).map(rowText),
    }).toEqual({
      paintedMode: "scrolled",
      paintedTopRow: beforeTopRow,
      beforeTopRow,
      restoredBottomRows: [expectedBenchmarkLine(34), ""],
    });
  });

  test("snapshot restore keeps a following viewport at the new bottom", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: ROWS, cols: COLS, scrollbackLines: 100 });
    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount: 10, cols: COLS }),
    );
    const model = createNativeTerminalScreenModel({ terminal });
    model.sync({ visibleRows: ROWS });

    const screen = await createScreenRestorer(terminal, model).restore(await benchmarkSnapshot(20));
    const paintedRows = screen?.viewport.grid.map(rowText).filter((line) => line.length > 0) ?? [];

    expect({ paintedMode: screen?.scroll.mode, bottomRows: paintedRows.slice(-2) }).toEqual({
      paintedMode: "following",
      bottomRows: [expectedBenchmarkLine(18), expectedBenchmarkLine(19)],
    });
  });
});

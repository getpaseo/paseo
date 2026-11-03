import { createTerminalResizePolicy, updateTerminalResizePolicy } from "./terminal-resize-policy";
import { describe, expect, test } from "vitest";

import {
  createNativeHeadlessTerminal,
  type TerminalViewportState,
} from "./headless-terminal-state";
import { createNativeTerminalBenchmarkPayload } from "./native-terminal-benchmark-payload";
import {
  createNativeTerminalOutputDrain,
  NATIVE_TERMINAL_PARSE_CHUNK_CHARS,
} from "./headless-terminal-output-drain";
import { createNativeTerminalScreenModel, type TerminalScreenState } from "./terminal-screen-model";
import { Terminal as ReplaySource } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

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
  return {
    rows: ROWS,
    cols: COLS,
    data: new TextEncoder().encode(
      createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount, cols: COLS }),
    ),
  };
}

function createScreenRestorer(
  terminal: ReturnType<typeof createNativeHeadlessTerminal>,
  model: ReturnType<typeof createNativeTerminalScreenModel>,
) {
  const frameRecorder = createFrameRecorder();
  let screen: TerminalScreenState | null = null;
  const drain = createNativeTerminalOutputDrain({
    restoreSize: () => {},
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
      drain.replay({ type: "begin", rows: snapshot.rows, cols: snapshot.cols });
      drain.replay({
        type: "data",
        data: snapshot.data,
      });
      drain.replay({ type: "end" });
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
      restoreSize: () => {},
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
      restoreSize: () => {},
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
      restoreSize: () => {},
      write: (chunk) => terminal.write(chunk),
      reset: () => terminal.reset(),
      getViewportState: () => terminal.getViewportState(),
      onPaint: () => {},
      scheduleWork: (callback) => scheduledWork.push(callback),
      scheduleFrame: frameRecorder.scheduleFrame,
      cancelFrame: frameRecorder.cancelFrame,
    });
    const restoredCursor = { row: 1, col: "restored-two".length };
    const replay = new TextEncoder().encode("restored-one\r\nrestored-two");

    await terminal.write("old-one\r\nold-two\r\nold-three\r\n");
    drain.enqueueText("stale-queued\r\n");
    drain.replay({ type: "begin" });
    drain.replay({
      type: "data",
      data: replay,
    });
    drain.replay({ type: "end" });
    await runScheduledWork({ callbacks: scheduledWork, flush: drain.flush() });

    const state = terminal.getViewportState();
    expect(state.grid.map(rowText)).toEqual(["restored-one", "restored-two", "", ""]);
    expect(state.cursor).toEqual(restoredCursor);
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
      restoredBottomRows: terminal.getViewportState().grid.slice(-2).map(rowText),
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

test("replays split Unicode and ANSI with one reset then live output", async () => {
  const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 40, scrollbackLines: 1000 });
  let resets = 0;
  const drain = createNativeTerminalOutputDrain({
    restoreSize: () => {},
    write: (text) => terminal.write(text),
    reset: (size) => {
      resets++;
      if (size) terminal.resize(size);
      terminal.reset();
    },
    getViewportState: () => terminal.getViewportState(),
    onPaint: () => {},
  });
  try {
    drain.replay({ type: "begin", rows: 4, cols: 40, retainedHistoryLines: 400 });
    const bytes = new TextEncoder().encode("\x1b[31m界🙂 replay\x1b[0m\r\n");
    for (let i = 0; i < bytes.length; i++)
      drain.replay({ type: "data", data: bytes.subarray(i, i + 1) });
    drain.replay({ type: "end" });
    drain.enqueueText("live");
    await drain.flush();
    expect(resets).toBe(1);
    expect(
      terminal
        .getBufferWindow({ startRow: 0, rowCount: 4 })
        .rows.map((row) =>
          row
            .filter((cell) => cell.width !== 0)
            .map((cell) => cell.char)
            .join(""),
        )
        .join("\n"),
    ).toContain("界🙂 replay");
    expect(
      terminal
        .getBufferWindow({ startRow: 0, rowCount: 4 })
        .rows.map((row) =>
          row
            .filter((cell) => cell.width !== 0)
            .map((cell) => cell.char)
            .join(""),
        )
        .join("\n"),
    ).toContain("live");
  } finally {
    drain.dispose();
    terminal.dispose();
  }
});

test("an empty replacement replay resets after an in-flight write finishes", async () => {
  let finish!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let resets = 0;
  const drain = createNativeTerminalOutputDrain({
    restoreSize: () => {},
    write: async () => {
      started();
      await blocked;
    },
    reset: () => {
      resets++;
    },
    getViewportState: () => null,
    onPaint: () => {},
  });
  try {
    drain.enqueueText("old terminal");
    await writing;
    drain.replay({ type: "begin" });
    drain.replay({ type: "end" });
    finish();
    await drain.flush();
    expect(resets).toBe(1);
    expect(drain.getQueuedChars()).toBe(0);
  } finally {
    finish();
    drain.dispose();
  }
});

test("replay geometry returns to measured layout before live writes and unchanged-layout focus", async () => {
  const measured = { rows: 24, cols: 40 };
  const terminal = createNativeHeadlessTerminal({ ...measured, scrollbackLines: 1000 });
  const policy = createTerminalResizePolicy(measured);
  const sizes: number[] = [];
  const drain = createNativeTerminalOutputDrain({
    write: async (text) => {
      sizes.push(terminal.getViewportState().cols);
      await terminal.write(text);
    },
    reset: (size) => {
      if (size) terminal.resize(size);
      terminal.reset();
    },
    restoreSize: () => terminal.resize(measured),
    getViewportState: () => terminal.getViewportState(),
    onPaint: () => {},
  });
  try {
    drain.replay({ type: "begin", rows: 30, cols: 120 });
    drain.replay({ type: "data", data: new TextEncoder().encode("x".repeat(100) + "\r\n") });
    drain.replay({ type: "end" });
    drain.enqueueText("LIVE-" + "y".repeat(60));
    await drain.flush();
    expect(sizes).toEqual([120, 40]);
    const focus = updateTerminalResizePolicy(policy, {
      source: "claim",
      size: measured,
      claimToken: 1,
    });
    expect(focus.measuredSizeChanged).toBe(false);
    expect(focus.resizeClaim).toMatchObject(measured);
    expect(terminal.getViewportState()).toMatchObject(measured);
    expect(terminal.getBufferBounds().cols).toBe(40);
    const lines = terminal
      .getViewportState()
      .grid.map((row) =>
        row
          .map((cell) => cell.char)
          .join("")
          .trimEnd(),
      )
      .join("\n");
    expect(lines).toContain("LIVE-" + "y".repeat(35) + "\n" + "y".repeat(25));
  } finally {
    drain.dispose();
    terminal.dispose();
  }
});

test.each(["clear", "replacement", "dispose"] as const)(
  "cancels queued replay geometry on %s",
  async (action) => {
    const local = { rows: 24, cols: 40 };
    const terminal = createNativeHeadlessTerminal({ ...local, scrollbackLines: 1000 });
    let finish!: () => void;
    const block = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    let restores = 0;
    const drain = createNativeTerminalOutputDrain({
      restoreSize: () => {
        restores++;
        terminal.resize(local);
      },
      reset: (size) => {
        if (size) terminal.resize(size);
        terminal.reset();
      },
      write: async (text) => {
        await terminal.write(text);
        if (first) {
          first = false;
          started();
          await block;
        }
      },
      getViewportState: () => terminal.getViewportState(),
      onPaint: () => {},
    });
    try {
      drain.replay({ type: "begin", rows: 30, cols: 120 });
      drain.replay({ type: "data", data: new TextEncoder().encode("old") });
      await writing;
      local.cols = 60;
      drain.resize();
      expect(terminal.getViewportState().cols).toBe(120);
      drain.replay({ type: "end" });
      if (action === "clear") drain.clear();
      else if (action === "dispose") {
        drain.dispose();
        drain.clear();
      } else {
        drain.replay({ type: "begin", rows: 20, cols: 80 });
        drain.replay({ type: "data", data: new TextEncoder().encode("new") });
        drain.replay({ type: "end" });
      }
      finish();
      await drain.flush();
      expect(restores).toBe(action === "dispose" ? 0 : 1);
      if (action !== "dispose") expect(terminal.getViewportState()).toMatchObject(local);
    } finally {
      finish();
      drain.dispose();
      terminal.dispose();
    }
  },
);

test("holds captured geometry across mid-replay measurement changes", async () => {
  const source = new ReplaySource({ rows: 4, cols: 8, scrollback: 100, allowProposedApi: true });
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  await new Promise<void>((resolve) =>
    source.write("ABCDEFGH\r\n12345678\r\nabcdefgh\r\nxyz\x1b[2;8H", resolve),
  );
  const ansi = new TextEncoder().encode(serializer.serialize());
  const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 8, scrollbackLines: 100 });
  const expected = createNativeHeadlessTerminal({ rows: 4, cols: 8, scrollbackLines: 100 });
  await expected.write(new TextDecoder().decode(ansi));
  expected.resize({ rows: 4, cols: 4 });
  let measured = { rows: 4, cols: 8 };
  const drain = createNativeTerminalOutputDrain({
    write: (chunk) => terminal.write(chunk),
    reset: (size) => {
      if (size) terminal.resize(size);
      terminal.reset();
    },
    restoreSize: () => terminal.resize(measured),
    getViewportState: () => terminal.getViewportState(),
    onPaint: () => {},
  });
  try {
    drain.replay({ type: "begin", rows: 4, cols: 8 });
    await drain.flush();
    measured = { rows: 4, cols: 4 };
    drain.resize();
    drain.replay({ type: "data", data: ansi });
    drain.replay({ type: "end" });
    await drain.flush();
    expect(terminal.getViewportState()).toEqual(expected.getViewportState());
    const actualBounds = terminal.getBufferBounds();
    const expectedBounds = expected.getBufferBounds();
    expect(
      terminal.getBufferWindow({
        startRow: actualBounds.oldestRow,
        rowCount: actualBounds.newestRow - actualBounds.oldestRow + 1,
      }),
    ).toEqual(
      expected.getBufferWindow({
        startRow: expectedBounds.oldestRow,
        rowCount: expectedBounds.newestRow - expectedBounds.oldestRow + 1,
      }),
    );
  } finally {
    drain.dispose();
  }
});

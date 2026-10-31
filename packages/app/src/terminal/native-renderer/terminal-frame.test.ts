import { describe, expect, test } from "vitest";

import graphemeRows from "../../../modules/paseo-terminal/android/src/androidTest/assets/grapheme-rows.json";
import { PASEO_TERMINAL_STYLE_FLAGS } from "../../../modules/paseo-terminal/contract";
import { encodeTerminalFrame } from "../../../modules/paseo-terminal/frame-encoding";
import {
  createTerminalCellStyleResolver,
  DEFAULT_TERMINAL_THEME,
  parseTerminalColor,
} from "./colors";
import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import { buildTerminalFrame } from "./terminal-frame";
import { createNativeTerminalOutputDrain } from "./headless-terminal-output-drain";
import { resolveMeasuredNativeTerminalSize } from "./terminal-size-measurement";

const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
const RED = parseTerminalColor(DEFAULT_TERMINAL_THEME.red, 0);
const FOREGROUND = parseTerminalColor(DEFAULT_TERMINAL_THEME.foreground, 0);

async function frameFor(output: string, options: { cols?: number; rows?: number } = {}) {
  const terminal = createNativeHeadlessTerminal({
    cols: options.cols ?? 20,
    rows: options.rows ?? 4,
  });
  await terminal.write(output);
  const state = terminal.getViewportState({ firstRow: 0, rowCount: options.rows ?? 4 });
  terminal.dispose();
  return {
    state,
    frame: buildTerminalFrame({ state, columns: state.cols, resolver, selection: null }),
  };
}

function cellLayout(row: { text: string; cells: number[] }) {
  const layout: Array<{ text: string; col: number; span: number }> = [];
  let offset = 0;
  let col = 0;
  for (let index = 0; index < row.cells.length; index += 2) {
    const [length, span] = [row.cells[index], row.cells[index + 1]];
    layout.push({ text: row.text.slice(offset, offset + length), col, span });
    offset += length;
    col += span;
  }
  return layout;
}

/** Indexes of the cells that start a grapheme cluster. */
function clusterStartCells(row: { text: string; cells: number[] }, segmenter: Intl.Segmenter) {
  const boundaries = new Set(Array.from(segmenter.segment(row.text), (segment) => segment.index));
  const starts: number[] = [];
  let offset = 0;
  for (let cell = 0; cell < row.cells.length / 2; cell += 1) {
    if (boundaries.has(offset)) starts.push(cell);
    offset += row.cells[cell * 2];
  }
  return starts;
}

describe("native terminal frame", () => {
  test("keeps each Hangul syllable on xterm's two-column allocation", async () => {
    const { frame } = await frameFor("> 안녕하세요");

    expect(cellLayout(frame.rows[0]).slice(0, 7)).toEqual([
      { text: ">", col: 0, span: 1 },
      { text: " ", col: 1, span: 1 },
      { text: "안", col: 2, span: 2 },
      { text: "녕", col: 4, span: 2 },
      { text: "하", col: 6, span: 2 },
      { text: "세", col: 8, span: 2 },
      { text: "요", col: 10, span: 2 },
    ]);
    expect(frame.cursor).toEqual({ row: 0, col: 12 });
  });

  test("covers every column once, including trailing blanks", async () => {
    const corpus = ["안녕하세요NEXT", "日本語 中文", "áé é x̸", "क्ष कि ❤️ 👩‍💻 🇰🇷"];
    const { frame } = await frameFor(corpus.join("\r\n"), { rows: 4, cols: 24 });

    for (const row of frame.rows) {
      const spans = row.cells.filter((_, index) => index % 2 === 1);
      const styleColumns = row.styles.filter((_, index) => index % 4 === 0);
      expect(spans.reduce((total, span) => total + span, 0)).toBe(24);
      expect(styleColumns.reduce((total, span) => total + span, 0)).toBe(24);
      expect(row.cells.filter((_, index) => index % 2 === 0).reduce((a, b) => a + b, 0)).toBe(
        row.text.length,
      );
    }
  });

  test("keeps combining marks and joiners inside the cell xterm assigned them", async () => {
    const { frame } = await frameFor("éx̸ 각 क्ष 👩‍💻");

    expect(cellLayout(frame.rows[0]).slice(0, 11)).toEqual([
      { text: "é", col: 0, span: 1 },
      { text: "x̸", col: 1, span: 1 },
      { text: " ", col: 2, span: 1 },
      { text: "각", col: 3, span: 2 },
      { text: " ", col: 5, span: 1 },
      { text: "क्", col: 6, span: 1 },
      { text: "ष", col: 7, span: 1 },
      { text: " ", col: 8, span: 1 },
      { text: "👩‍", col: 9, span: 1 },
      { text: "💻", col: 10, span: 1 },
      { text: " ", col: 11, span: 1 },
    ]);
  });

  test("splits style spans at SGR changes without moving cells", async () => {
    const { frame } = await frameFor("안녕\x1b[31mNEXT\x1b[0m\x1b[1;4m!\x1b[0m");
    const row = frame.rows[0];

    expect(
      cellLayout(row)
        .slice(0, 7)
        .map((cell) => cell.col),
    ).toEqual([0, 2, 4, 5, 6, 7, 8]);
    expect(row.styles.slice(0, 12)).toEqual([
      4,
      FOREGROUND,
      0,
      0,
      4,
      RED,
      0,
      0,
      1,
      FOREGROUND,
      0,
      PASEO_TERMINAL_STYLE_FLAGS.bold | PASEO_TERMINAL_STYLE_FLAGS.underline,
    ]);
  });

  test("resolves inverse and dim into paint colors", async () => {
    const { frame } = await frameFor("\x1b[7mI\x1b[0m\x1b[2mD\x1b[0m");
    const background = parseTerminalColor(DEFAULT_TERMINAL_THEME.background, 0);

    expect(frame.rows[0].styles.slice(0, 8)).toEqual([
      1,
      background,
      FOREGROUND,
      0,
      1,
      (((Math.round(255 * 0.65) & 0xff) << 24) | (FOREGROUND & 0xffffff)) >>> 0,
      0,
      PASEO_TERMINAL_STYLE_FLAGS.dim,
    ]);
  });

  test("rows follow content and style but not cursor or selection", async () => {
    const plain = await frameFor("same\r\nrow");
    const moved = await frameFor("same\r\nrow\x1b[1;1H");
    const recolored = await frameFor("\x1b[31msame\x1b[0m\r\nrow");

    expect(moved.frame.rows[0]).toEqual(plain.frame.rows[0]);
    expect(moved.frame.cursor).not.toEqual(plain.frame.cursor);
    expect(recolored.frame.rows[0]).not.toEqual(plain.frame.rows[0]);

    const selected = buildTerminalFrame({
      state: plain.state,
      columns: plain.state.cols,
      resolver,
      selection: {
        start: { row: 0, col: 1 },
        end: { row: 1, col: 0 },
        coordinateEpoch: 0,
      },
    });
    expect(selected.rows).toEqual(plain.frame.rows);
    expect(selected.selection).toEqual({ startRow: 0, startCol: 1, endRow: 1, endCol: 0 });
  });

  test("clips the frame to the visible columns", async () => {
    const { state } = await frameFor("0123456789abcdefghij");
    const frame = buildTerminalFrame({ state, columns: 8, resolver, selection: null });

    expect(frame.columns).toBe(8);
    expect(frame.rows[0].text).toBe("01234567");
  });

  // The Android instrumented test draws these rows and compares them with each cluster drawn on its
  // own. This keeps its input equal to what xterm produces, and its clusters equal to UAX #29
  // grapheme clusters. `contrastStarts` is a wrong clustering the comparison must reject.
  test("Android cluster fixture matches xterm cells and grapheme clusters", async () => {
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    const actual = await Promise.all(
      graphemeRows.map(async ({ output, contrastStarts }) => {
        const { frame } = await frameFor(output, { cols: 8, rows: 1 });
        const row = frame.rows[0];
        const [encoded] = encodeTerminalFrame({ ...frame, rows: [row] }).rows;
        return {
          output,
          row: encoded,
          clusterStarts: clusterStartCells(row, segmenter),
          contrastStarts,
        };
      }),
    );

    expect(actual).toEqual(graphemeRows);
  });
});

test("builds native frames after replay commits at captured geometry and the latest measurement precedes live text", async () => {
  let measured = resolveMeasuredNativeTerminalSize({
    layout: { width: 400, height: 240 },
    metrics: { cellWidth: 10, cellHeight: 10 },
  })!;
  const terminal = createNativeHeadlessTerminal({ ...measured, scrollbackLines: 10000 });
  const parsedColumns: number[] = [];
  const drain = createNativeTerminalOutputDrain({
    write: async (text) => {
      parsedColumns.push(terminal.getViewportState().cols);
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
    measured = resolveMeasuredNativeTerminalSize({
      layout: { width: 500, height: 100 },
      metrics: { cellWidth: 10, cellHeight: 10 },
    })!;
    drain.resize();
    drain.replay({ type: "end" });
    drain.enqueueText("\x1b[H\x1b[2K\x1b[31mLIVE-界🙂\x1b[0m");
    await drain.flush();
    expect(parsedColumns).toEqual([120, 50]);
    const state = terminal.getViewportState();
    const frame = buildTerminalFrame({ state, columns: state.cols, resolver, selection: null });
    expect(frame.columns).toBe(50);
    expect(frame.rows).toHaveLength(10);
    expect(frame.rows[0].text.trimEnd()).toBe("LIVE-界🙂");
    expect(frame.rows[0].styles.slice(0, 4)).toEqual([8, RED, 0, 0]);
    expect(encodeTerminalFrame(frame).rows[0]).toContain("LIVE-界🙂");
  } finally {
    drain.dispose();
    terminal.dispose();
  }
});

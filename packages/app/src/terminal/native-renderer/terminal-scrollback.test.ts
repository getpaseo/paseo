import { describe, expect, test } from "vitest";

import {
  createNativeHeadlessTerminal,
  type TerminalCellRow,
  type TerminalViewportState,
} from "./headless-terminal-state";
import { createNativeTerminalBenchmarkPayload } from "./native-terminal-benchmark-payload";
import { createNativeTerminalScreenModel } from "./terminal-screen-model";

const ROWS = 10;
const COLS = 80;
const SCROLLBACK = 100;

function rowText(row: TerminalCellRow | TerminalViewportState["grid"][number]): string {
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

async function seedLargeOutput(input: {
  rows: number;
  cols: number;
  scrollbackLines: number;
  lineCount: number;
}) {
  const terminal = createNativeHeadlessTerminal({
    rows: input.rows,
    cols: input.cols,
    scrollbackLines: input.scrollbackLines,
  });
  await terminal.write(
    createNativeTerminalBenchmarkPayload({
      startLine: 0,
      lineCount: input.lineCount,
      cols: input.cols,
    }),
  );
  return terminal;
}

describe("native terminal scrollback retention", () => {
  test("large output retains non-zero scrollback matching configured lines", async () => {
    const terminal = await seedLargeOutput({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: SCROLLBACK,
      lineCount: SCROLLBACK + ROWS + 10,
    });
    const state = terminal.getState();
    const bounds = terminal.getBufferBounds();

    expect(state.scrollback.length).toBeGreaterThan(0);
    expect(state.scrollback.length).toBeLessThanOrEqual(SCROLLBACK);
    expect(bounds.newestRow).toBeGreaterThan(ROWS);
    expect(bounds.oldestRow).toBe(0);
  });

  test("observable scrollback count is bounded by configured lines", async () => {
    const terminal = await seedLargeOutput({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: SCROLLBACK,
      lineCount: SCROLLBACK * 3,
    });
    const state = terminal.getState();

    expect(state.scrollback.length).toBe(SCROLLBACK);
  });

  test("scroll up moves viewport into retained history", async () => {
    const terminal = await seedLargeOutput({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: SCROLLBACK,
      lineCount: ROWS + 15,
    });
    const model = createNativeTerminalScreenModel({ terminal });

    const bottom = model.sync({ visibleRows: ROWS });
    const scrolled = model.scrollUp({ rows: 5, visibleRows: ROWS });

    expect(bottom.scroll.mode).toBe("following");
    expect(scrolled.scroll.mode).toBe("scrolled");
    expect(scrolled.scroll.firstRow).toBeLessThan(bottom.scroll.firstRow);
    expect(scrolled.viewport.firstRow).toBe(scrolled.scroll.firstRow);
    expect(scrolled.viewport.grid.map(rowText).slice(0, 3)).toEqual([
      expectedBenchmarkLine(scrolled.scroll.firstRow),
      expectedBenchmarkLine(scrolled.scroll.firstRow + 1),
      expectedBenchmarkLine(scrolled.scroll.firstRow + 2),
    ]);
  });

  test("scrolled state is preserved when new output arrives", async () => {
    const terminal = await seedLargeOutput({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: SCROLLBACK,
      lineCount: ROWS + 20,
    });
    const model = createNativeTerminalScreenModel({ terminal });

    model.sync({ visibleRows: ROWS });
    const scrolled = model.scrollUp({ rows: 8, visibleRows: ROWS });
    const topRowBefore = scrolled.scroll.firstRow;

    await terminal.write(
      createNativeTerminalBenchmarkPayload({
        startLine: ROWS + 20,
        lineCount: 5,
        cols: COLS,
      }),
    );
    const after = model.sync({ visibleRows: ROWS });

    expect(after.scroll.mode).toBe("scrolled");
    expect(after.scroll.firstRow).toBe(topRowBefore);
  });

  test("bottom affordance returns to tail and resumes following", async () => {
    const terminal = await seedLargeOutput({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: SCROLLBACK,
      lineCount: ROWS + 20,
    });
    const model = createNativeTerminalScreenModel({ terminal });

    model.sync({ visibleRows: ROWS });
    model.scrollUp({ rows: 10, visibleRows: ROWS });
    const bottom = model.returnToBottom({ visibleRows: ROWS });

    expect(bottom.scroll.mode).toBe("following");
    expect(bottom.scroll.firstRow).toBe(bottom.scroll.bottomViewport.firstRow);
    expect(bottom.viewport.firstRow).toBe(bottom.scroll.bottomViewport.firstRow);
  });

  test("following mode tracks bottom as live output continues", async () => {
    const terminal = await seedLargeOutput({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: SCROLLBACK,
      lineCount: ROWS + 2,
    });
    const model = createNativeTerminalScreenModel({ terminal });

    const before = model.sync({ visibleRows: ROWS });
    await terminal.write(
      createNativeTerminalBenchmarkPayload({
        startLine: ROWS + 2,
        lineCount: 8,
        cols: COLS,
      }),
    );
    const after = model.sync({ visibleRows: ROWS });

    expect(after.scroll.mode).toBe("following");
    expect(after.scroll.firstRow).toBeGreaterThan(before.scroll.firstRow);
    expect(after.scroll.bottomViewport.lastRow).toBeGreaterThan(
      before.scroll.bottomViewport.lastRow,
    );
  });
});

import { describe, expect, test } from "vitest";

import { createNativeHeadlessTerminal, type TerminalCellRow } from "./headless-terminal-state";
import { createNativeTerminalBenchmarkPayload } from "./native-terminal-benchmark-payload";
import { createNativeTerminalScreenModel } from "./terminal-screen-model";

const ROWS = 5;
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

function filledRows(rows: TerminalCellRow[]): string[] {
  return rows.map(rowText).filter((text) => text.length > 0);
}

function viewportRows(model: ReturnType<typeof createNativeTerminalScreenModel>) {
  return filledRows(model.sync({ visibleRows: ROWS }).viewport.grid);
}

async function createScrolledTerminal(lineCount: number) {
  const terminal = createNativeHeadlessTerminal({ rows: ROWS, cols: COLS, scrollbackLines: 100 });
  await terminal.write(
    createNativeTerminalBenchmarkPayload({ startLine: 0, lineCount, cols: COLS }),
  );
  return terminal;
}

describe("native terminal screen model", () => {
  test("scrolling up changes the visible window after output exceeds the viewport", async () => {
    const terminal = await createScrolledTerminal(20);
    const model = createNativeTerminalScreenModel({ terminal });
    const bottomRows = viewportRows(model);

    const scrolled = model.scrollUp({ rows: 3, visibleRows: ROWS });

    expect({
      mode: scrolled.scroll.mode,
      firstRowChanged: scrolled.scroll.firstRow < scrolled.scroll.bottomViewport.firstRow,
      bottomRows,
      rows: filledRows(scrolled.viewport.grid),
    }).toEqual({
      mode: "scrolled",
      firstRowChanged: true,
      bottomRows: [16, 17, 18, 19].map(expectedBenchmarkLine),
      rows: [13, 14, 15, 16, 17].map(expectedBenchmarkLine),
    });
  });

  test("following mode tracks the bottom when new output arrives", async () => {
    const terminal = await createScrolledTerminal(10);
    const model = createNativeTerminalScreenModel({ terminal });

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 10, lineCount: 5, cols: COLS }),
    );
    const screen = model.sync({ visibleRows: ROWS });

    expect({
      mode: screen.scroll.mode,
      firstRow: screen.scroll.firstRow,
      bottomFirstRow: screen.scroll.bottomViewport.firstRow,
      rows: filledRows(screen.viewport.grid),
    }).toEqual({
      mode: "following",
      firstRow: screen.scroll.bottomViewport.firstRow,
      bottomFirstRow: screen.scroll.bottomViewport.firstRow,
      rows: [11, 12, 13, 14].map(expectedBenchmarkLine),
    });
  });

  test("scrolled mode preserves the user's first row when new output arrives", async () => {
    const terminal = await createScrolledTerminal(20);
    const model = createNativeTerminalScreenModel({ terminal });
    const before = model.scrollUp({ rows: 4, visibleRows: ROWS });

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 20, lineCount: 5, cols: COLS }),
    );
    const after = model.sync({ visibleRows: ROWS });

    expect({
      mode: after.scroll.mode,
      firstRowBefore: before.scroll.firstRow,
      firstRowAfter: after.scroll.firstRow,
      rows: filledRows(after.viewport.grid),
    }).toEqual({
      mode: "scrolled",
      firstRowBefore: before.scroll.firstRow,
      firstRowAfter: before.scroll.firstRow,
      rows: [12, 13, 14, 15, 16].map(expectedBenchmarkLine),
    });
  });

  test("scrolled mode does not follow new output when scrollback is already bounded", async () => {
    const terminal = await createScrolledTerminal(300);
    const model = createNativeTerminalScreenModel({ terminal });
    const before = model.scrollUp({ rows: 18, visibleRows: ROWS });
    const beforeRows = filledRows(before.viewport.grid);

    await terminal.write(
      createNativeTerminalBenchmarkPayload({ startLine: 300, lineCount: 5, cols: COLS }),
    );
    const after = model.sync({ visibleRows: ROWS });
    const afterRows = filledRows(after.viewport.grid);

    expect({
      mode: after.scroll.mode,
      topRowBefore: beforeRows[0],
      topRowAfter: afterRows[0],
      newOutputRows: [300, 301, 302, 303, 304]
        .map(expectedBenchmarkLine)
        .filter((line) => afterRows.includes(line)),
    }).toEqual({
      mode: "scrolled",
      topRowBefore: beforeRows[0],
      topRowAfter: beforeRows[0],
      newOutputRows: [],
    });
  });

  test("returning to bottom restores following", async () => {
    const terminal = await createScrolledTerminal(20);
    const model = createNativeTerminalScreenModel({ terminal });

    model.scrollUp({ rows: 5, visibleRows: ROWS });
    const bottom = model.returnToBottom({ visibleRows: ROWS });

    expect({
      mode: bottom.scroll.mode,
      firstRow: bottom.scroll.firstRow,
      bottomFirstRow: bottom.scroll.bottomViewport.firstRow,
      rows: filledRows(bottom.viewport.grid),
    }).toEqual({
      mode: "following",
      firstRow: bottom.scroll.bottomViewport.firstRow,
      bottomFirstRow: bottom.scroll.bottomViewport.firstRow,
      rows: [16, 17, 18, 19].map(expectedBenchmarkLine),
    });
  });

  test("scroll boundaries clamp at the oldest and newest rows", async () => {
    const terminal = await createScrolledTerminal(20);
    const model = createNativeTerminalScreenModel({ terminal });

    const oldest = model.scrollUp({ rows: 500, visibleRows: ROWS });
    const newest = model.scrollDown({ rows: 500, visibleRows: ROWS });

    expect({
      oldest: {
        mode: oldest.scroll.mode,
        firstRow: oldest.scroll.firstRow,
        oldestRow: oldest.scroll.oldestRow,
      },
      newest: {
        mode: newest.scroll.mode,
        firstRow: newest.scroll.firstRow,
        bottomFirstRow: newest.scroll.bottomViewport.firstRow,
      },
    }).toEqual({
      oldest: {
        mode: "scrolled",
        firstRow: oldest.scroll.oldestRow,
        oldestRow: oldest.scroll.oldestRow,
      },
      newest: {
        mode: "following",
        firstRow: newest.scroll.bottomViewport.firstRow,
        bottomFirstRow: newest.scroll.bottomViewport.firstRow,
      },
    });
  });

  test("repeated rows do not jump to an older matching anchor on consecutive slow scrolls", async () => {
    const terminal = createNativeHeadlessTerminal({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: 100,
    });
    const output = Array.from({ length: 8 }, (_, blockIndex) => {
      return `BLOCK_${blockIndex + 1}\r\n${"SAME\r\n".repeat(8)}`;
    }).join("");
    await terminal.write(output);
    const model = createNativeTerminalScreenModel({ terminal });

    const first = model.scrollUp({ rows: 2, visibleRows: ROWS });
    const second = model.scrollUp({ rows: 2, visibleRows: ROWS });
    const third = model.scrollUp({ rows: 2, visibleRows: ROWS });

    expect([first.scroll.firstRow, second.scroll.firstRow, third.scroll.firstRow]).toEqual([
      first.scroll.bottomViewport.firstRow - 2,
      first.scroll.bottomViewport.firstRow - 4,
      first.scroll.bottomViewport.firstRow - 6,
    ]);
  });

  test("keeps a retained viewport anchored across a burst larger than the old search window", async () => {
    const terminal = createNativeHeadlessTerminal({
      rows: ROWS,
      cols: COLS,
      scrollbackLines: 995,
    });
    const initial = Array.from({ length: 999 }, (_, index) =>
      index === 600 ? "ANCHOR_600\r\n" : "SAME\r\n",
    ).join("");
    await terminal.write(initial);
    const model = createNativeTerminalScreenModel({ terminal });
    const bottom = model.sync({ visibleRows: ROWS });
    const before = model.scrollUp({
      rows: bottom.scroll.bottomViewport.firstRow - 600,
      visibleRows: ROWS,
    });

    await terminal.write("SAME\r\n".repeat(300));
    const after = model.sync({ visibleRows: ROWS });

    expect({
      firstRowBefore: before.scroll.firstRow,
      firstRowAfter: after.scroll.firstRow,
      firstVisibleRowBefore: rowText(before.viewport.grid[0] ?? []),
      firstVisibleRowAfter: rowText(after.viewport.grid[0] ?? []),
    }).toEqual({
      firstRowBefore: 600,
      firstRowAfter: 600,
      firstVisibleRowBefore: "ANCHOR_600",
      firstVisibleRowAfter: "ANCHOR_600",
    });
  });

  test("reset while scrolled drops the old viewport before restored content is read", async () => {
    const terminal = await createScrolledTerminal(20);
    const model = createNativeTerminalScreenModel({ terminal });

    model.scrollUp({ rows: 5, visibleRows: ROWS });
    terminal.reset();
    await terminal.write("restored one\r\nrestored two\r\n");
    model.reset();
    const restored = model.sync({ visibleRows: ROWS });

    expect({
      mode: restored.scroll.mode,
      rows: filledRows(restored.viewport.grid),
    }).toEqual({
      mode: "following",
      rows: ["restored one", "restored two"],
    });
  });
});

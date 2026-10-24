import type { TerminalCell } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";

import { createTerminalCellStyleResolver, DEFAULT_TERMINAL_THEME } from "./colors";
import { buildRows } from "./terminal-row-model";

function cell(
  char: string,
  overrides: Partial<TerminalCell> & { width?: number } = {},
): TerminalCell & { width?: number } {
  return { char, ...overrides };
}

describe("terminal row model", () => {
  test("preserves terminal cell width for styled runs and trailing spaces", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);

    const rows = buildRows({
      grid: [
        [cell("n", { bg: 2, bgMode: 1 }), cell("v", { bg: 2, bgMode: 1 }), cell(" "), cell(" ")],
      ],
      resolver,
    });

    expect(rows[0].runs.map((run) => ({ text: run.text, cellCount: run.cellCount }))).toEqual([
      { text: "nv", cellCount: 2 },
      { text: "  ", cellCount: 2 },
    ]);
  });

  test("uses xterm's authoritative width instead of guessing from the code point", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);

    const rows = buildRows({
      grid: [[cell("A", { width: 2 }), cell(" ", { width: 0 }), cell("界", { width: 1 })]],
      resolver,
    });

    expect(rows[0].runs.map((run) => ({ text: run.text, cellCount: run.cellCount }))).toEqual([
      { text: "A", cellCount: 2 },
      { text: "界", cellCount: 1 },
    ]);
  });

  test("keeps wide scripts in the run as segments the renderer spaces to two cells", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);

    const rows = buildRows({
      grid: [
        [
          cell("한", { width: 2 }),
          cell(" ", { width: 0 }),
          cell("글", { width: 2 }),
          cell(" ", { width: 0 }),
          cell(" ", { width: 1 }),
          cell("中", { width: 2 }),
          cell(" ", { width: 0 }),
          cell("あ", { width: 2 }),
          cell(" ", { width: 0 }),
          cell("o", { width: 1 }),
          cell("k", { width: 1 }),
        ],
      ],
      resolver,
    });

    expect(
      rows[0].runs.map((run) => ({
        text: run.text,
        cellCount: run.cellCount,
        segments: run.renderKind === "text" ? run.segments : null,
      })),
    ).toEqual([
      {
        text: "한글 中あok",
        cellCount: 11,
        segments: [
          { text: "한글", wideGlyphClass: "hangul" },
          { text: " ", wideGlyphClass: null },
          { text: "中", wideGlyphClass: "han" },
          { text: "あ", wideGlyphClass: "kana" },
          { text: "ok", wideGlyphClass: null },
        ],
      },
    ]);
  });

  test("gives wide glyphs outside the spaced scripts their own box", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);

    const [row] = buildRows({
      grid: [
        [
          cell("ㄱ", { width: 2 }),
          cell(" ", { width: 0 }),
          cell("Ａ", { width: 2 }),
          cell(" ", { width: 0 }),
          cell("가", { width: 2 }),
          cell(" ", { width: 0 }),
        ],
      ],
      resolver,
    });

    expect(
      row.runs.map((run) => [run.text, run.cellCount, run.renderKind === "text" && run.isolated]),
    ).toEqual([
      ["ㄱ", 2, true],
      ["Ａ", 2, true],
      ["가", 2, false],
    ]);
  });

  test("gives non-ASCII narrow glyphs their own cell", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);

    const [row] = buildRows({
      grid: [
        ["⏺", " ", "e\u0301", " ", "d", "o", "n", "e"].map((char) => cell(char, { width: 1 })),
      ],
      resolver,
    });

    expect(row.runs.map((run) => [run.text, run.cellCount])).toEqual([
      ["⏺", 1],
      [" ", 1],
      ["e\u0301", 1],
      [" done", 5],
    ]);
  });

  test("redraws selected cells with the terminal selection colors", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
    const grid = [[cell("a", { fg: 1, fgMode: 1 }), cell("b", { dim: true }), cell("c")]];

    const rows = buildRows({
      grid,
      resolver,
      selection: {
        range: {
          start: { row: 7, col: 1 },
          end: { row: 7, col: 2 },
          coordinateEpoch: 1,
        },
        firstRow: 7,
        backgroundColor: "#ffff00",
        foregroundColor: "#000000",
      },
    });

    expect(
      rows[0].runs.map((run) => ({
        text: run.text,
        color: run.style.color,
        backgroundColor: run.style.backgroundColor,
        opacity: run.style.opacity,
      })),
    ).toEqual([
      {
        text: "a",
        color: DEFAULT_TERMINAL_THEME.red,
        backgroundColor: undefined,
        opacity: undefined,
      },
      { text: "b", color: "#000000", backgroundColor: "#ffff00", opacity: 1 },
      { text: "c", color: "#000000", backgroundColor: "#ffff00", opacity: 1 },
    ]);
    expect(rows[0].hash).not.toBe(buildRows({ grid, resolver })[0].hash);
  });

  test("splits Claude box drawing from font text at exact terminal columns", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
    const frame = "╭─ Claude Code ───╮";

    const [row] = buildRows({
      grid: [frame.split("").map((char) => cell(char, { fg: 1, fgMode: 1 }))],
      resolver,
    });

    expect(
      row.runs.map((run) => ({
        text: run.text,
        cellCount: run.cellCount,
        renderKind: run.renderKind,
      })),
    ).toEqual([
      { text: "╭─", cellCount: 2, renderKind: "custom-glyph" },
      { text: " Claude Code ", cellCount: 13, renderKind: "text" },
      { text: "───╮", cellCount: 4, renderKind: "custom-glyph" },
    ]);
  });

  test("keeps Claude mascot glyphs custom while preserving copied row text", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
    const mascot = "▐▛███▜▌   Claude Code";

    const [row] = buildRows({
      grid: [mascot.split("").map((char) => cell(char, { fg: 1, fgMode: 1 }))],
      resolver,
    });

    expect(row.runs.map((run) => [run.text, run.renderKind])).toEqual([
      ["▐▛███▜▌", "custom-glyph"],
      ["   Claude Code", "text"],
    ]);
    expect(row.runs.map((run) => run.text).join("")).toBe(mascot);
  });
});

import type { TextStyle } from "react-native";
import type { TerminalCell } from "@getpaseo/protocol/messages";

import type { TerminalCellStyleResolver } from "./colors";

const WIDE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
];

export interface TerminalRun {
  key: string;
  text: string;
  cellCount: number;
  styleKey: string;
  style: TextStyle;
}

export interface TerminalRowModel {
  index: number;
  hash: string;
  runs: TerminalRun[];
}

function hashStringPart(hash: number, value: string): number {
  let nextHash = hash;
  for (let index = 0; index < value.length; index += 1) {
    nextHash = Math.imul(nextHash ^ value.charCodeAt(index), 16777619);
  }
  return nextHash;
}

function finishHash(hash: number): string {
  return (hash >>> 0).toString(36);
}

function terminalCharWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 1;
  const isWide = WIDE_CHAR_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
  return isWide ? 2 : 1;
}

function shouldSkipSpacerCell(cells: TerminalCell[], col: number, char: string): boolean {
  if (terminalCharWidth(char) < 2) {
    return false;
  }
  return cells[col + 1]?.char === " ";
}

function terminalCellCount(cells: TerminalCell[], col: number, char: string): number {
  if (shouldSkipSpacerCell(cells, col, char)) {
    return 2;
  }
  return 1;
}

function appendRun(input: {
  runs: TerminalRun[];
  text: string;
  cellCount: number;
  styleKey: string;
  style: TextStyle;
  col: number;
}): void {
  const previousRun = input.runs[input.runs.length - 1];
  if (previousRun && previousRun.styleKey === input.styleKey) {
    previousRun.text += input.text;
    previousRun.cellCount += input.cellCount;
    return;
  }

  input.runs.push({
    key: `${input.col}:${input.styleKey}`,
    text: input.text,
    cellCount: input.cellCount,
    styleKey: input.styleKey,
    style: input.style,
  });
}

function buildRowModel(input: {
  cells: TerminalCell[];
  index: number;
  resolver: TerminalCellStyleResolver;
}): TerminalRowModel {
  const runs: TerminalRun[] = [];
  let hash = 2166136261;

  for (let col = 0; col < input.cells.length; col += 1) {
    const cell = input.cells[col];
    const text = cell.char || " ";
    const resolvedStyle = input.resolver.resolve(cell);
    const cellCount = terminalCellCount(input.cells, col, text);
    appendRun({
      runs,
      text,
      cellCount,
      styleKey: resolvedStyle.key,
      style: resolvedStyle.style,
      col,
    });
    hash = hashStringPart(hash, text);
    hash = hashStringPart(hash, resolvedStyle.key);

    if (cellCount > 1) {
      col += 1;
    }
  }

  return {
    index: input.index,
    hash: finishHash(hash),
    runs,
  };
}

export function buildRows(input: {
  grid: TerminalCell[][];
  resolver: TerminalCellStyleResolver;
}): TerminalRowModel[] {
  return input.grid.map((cells, index) =>
    buildRowModel({ cells, index, resolver: input.resolver }),
  );
}

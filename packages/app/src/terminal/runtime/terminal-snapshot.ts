import type { TerminalCell, TerminalState } from "@server/shared/messages";

type TerminalStyle = {
  fg: number | undefined;
  bg: number | undefined;
  fgMode: number | undefined;
  bgMode: number | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  inverse: boolean;
  strikethrough: boolean;
};

const DEFAULT_STYLE: TerminalStyle = {
  fg: undefined,
  bg: undefined,
  fgMode: undefined,
  bgMode: undefined,
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  inverse: false,
  strikethrough: false,
};

export function renderTerminalSnapshotToAnsi(state: TerminalState): string {
  const rows = [...state.scrollback, ...state.grid];
  const lines: string[] = ["\u001b[?7l"];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    lines.push(renderTerminalRow(row));
    if (rowIndex < rows.length - 1) {
      lines.push("\r\n");
    }
  }

  lines.push("\u001b[0m");
  const cursorPresentationAnsi = renderCursorPresentationToAnsi(state.cursor);
  if (cursorPresentationAnsi) {
    lines.push(cursorPresentationAnsi);
  }
  lines.push(`\u001b[${state.cursor.row + 1};${state.cursor.col + 1}H`);
  lines.push(state.cursor.hidden ? "\u001b[?25l" : "\u001b[?25h");
  lines.push("\u001b[?7h");
  return lines.join("");
}

function renderCursorPresentationToAnsi(cursor: TerminalState["cursor"]): string | null {
  if (!cursor.style) {
    return null;
  }

  const cursorStyleCode = (() => {
    if (cursor.style === "block") {
      return cursor.blink === false ? 2 : 1;
    }
    if (cursor.style === "underline") {
      return cursor.blink === false ? 4 : 3;
    }
    return cursor.blink === false ? 6 : 5;
  })();

  return `\u001b[${cursorStyleCode} q`;
}

function renderTerminalRow(row: TerminalCell[]): string {
  const output: string[] = [];
  const length = getTerminalRowLength(row);
  let previousStyle = DEFAULT_STYLE;

  for (let index = 0; index < length; index += 1) {
    const cell = row[index] ?? { char: " " };
    const nextStyle = getTerminalStyle(cell);
    if (!terminalStylesEqual(previousStyle, nextStyle)) {
      output.push(styleToAnsi(nextStyle));
      previousStyle = nextStyle;
    }
    output.push(cell.char || " ");
  }

  if (!terminalStylesEqual(previousStyle, DEFAULT_STYLE)) {
    output.push("\u001b[0m");
  }

  return output.join("");
}

function getTerminalRowLength(row: TerminalCell[]): number {
  for (let index = row.length - 1; index >= 0; index -= 1) {
    const cell = row[index];
    if (!cell) {
      continue;
    }
    if (cell.char !== " ") {
      return index + 1;
    }
    if (
      cell.fg !== undefined ||
      cell.bg !== undefined ||
      cell.fgMode !== undefined ||
      cell.bgMode !== undefined ||
      cell.bold ||
      cell.italic ||
      cell.underline ||
      cell.dim ||
      cell.inverse ||
      cell.strikethrough
    ) {
      return index + 1;
    }
  }
  return 0;
}

function getTerminalStyle(cell: TerminalCell): TerminalStyle {
  return {
    fg: cell.fg,
    bg: cell.bg,
    fgMode: cell.fgMode,
    bgMode: cell.bgMode,
    bold: Boolean(cell.bold),
    italic: Boolean(cell.italic),
    underline: Boolean(cell.underline),
    dim: Boolean(cell.dim),
    inverse: Boolean(cell.inverse),
    strikethrough: Boolean(cell.strikethrough),
  };
}

function terminalStylesEqual(left: TerminalStyle, right: TerminalStyle): boolean {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.fgMode === right.fgMode &&
    left.bgMode === right.bgMode &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.dim === right.dim &&
    left.inverse === right.inverse &&
    left.strikethrough === right.strikethrough
  );
}

function styleToAnsi(style: TerminalStyle): string {
  const codes = ["0"];

  if (style.bold) {
    codes.push("1");
  }
  if (style.dim) {
    codes.push("2");
  }
  if (style.italic) {
    codes.push("3");
  }
  if (style.underline) {
    codes.push("4");
  }
  if (style.inverse) {
    codes.push("7");
  }
  if (style.strikethrough) {
    codes.push("9");
  }

  if (style.fg !== undefined && style.fgMode !== undefined) {
    codes.push(...colorToSgr(style.fgMode, style.fg, false));
  }

  if (style.bg !== undefined && style.bgMode !== undefined) {
    codes.push(...colorToSgr(style.bgMode, style.bg, true));
  }

  return `\u001b[${codes.join(";")}m`;
}

function colorToSgr(mode: number, value: number, background: boolean): string[] {
  if (mode === 1) {
    if (value >= 8) {
      return [String((background ? 100 : 90) + (value - 8))];
    }
    return [String((background ? 40 : 30) + value)];
  }

  if (mode === 2) {
    return [background ? "48" : "38", "5", String(value)];
  }

  if (mode === 3) {
    return [
      background ? "48" : "38",
      "2",
      String((value >> 16) & 0xff),
      String((value >> 8) & 0xff),
      String(value & 0xff),
    ];
  }

  return [];
}

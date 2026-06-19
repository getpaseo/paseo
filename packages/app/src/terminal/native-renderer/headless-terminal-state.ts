import {
  Terminal as HeadlessTerminal,
  type IBufferCell,
  type IBufferLine,
  type Terminal as HeadlessTerminalInstance,
} from "@xterm/headless";
import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";

export type NativeTerminalWriteData = Uint8Array | string;
export type TerminalCellRow = TerminalCell[];

export interface NativeHeadlessTerminalOptions {
  rows: number;
  cols: number;
  scrollbackLines?: number;
}

export interface NativeHeadlessTerminal {
  write(data: NativeTerminalWriteData): Promise<void>;
  getState(): TerminalState;
  getViewportState(input?: TerminalViewportStateInput): TerminalViewportState;
  getInputModeState(): NativeHeadlessTerminalInputModeState;
  getBufferBounds(): TerminalBufferBounds;
  getBufferWindow(input: TerminalBufferWindowInput): TerminalBufferWindow;
  resize(input: { rows: number; cols: number }): void;
  reset(): void;
  dispose(): void;
}

export interface NativeHeadlessTerminalInputModeState {
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
}

export interface TerminalBufferWindowInput {
  startRow: number;
  rowCount: number;
}

export interface TerminalViewportStateInput {
  firstRow: number;
  rowCount: number;
}

export interface TerminalRowRange {
  firstRow: number;
  lastRow: number;
}

export interface TerminalBufferBounds {
  rows: number;
  cols: number;
  oldestRow: number;
  newestRow: number;
  coordinateEpoch: number;
  currentViewport: TerminalRowRange;
  bottomViewport: TerminalRowRange;
  cursorRow: number;
  cursorCol: number;
}

export interface TerminalBufferWindow {
  startRow: number;
  rows: TerminalCellRow[];
  wrappedRows: boolean[];
}

export interface TerminalViewportState {
  rows: number;
  cols: number;
  firstRow: number;
  oldestRow: number;
  newestRow: number;
  grid: TerminalCell[][];
  cursor: TerminalState["cursor"];
}

interface XtermCoreService {
  decPrivateModes?: {
    applicationCursorKeys?: unknown;
    bracketedPasteMode?: unknown;
    cursorStyle?: unknown;
    cursorBlink?: unknown;
  };
  isCursorHidden?: unknown;
}

interface HeadlessTerminalWithCore {
  _core?: {
    coreService?: XtermCoreService;
  };
}

function blankCell(): TerminalCell {
  return { char: " ", fg: undefined, bg: undefined };
}

function extractCell(
  line: IBufferLine | undefined,
  col: number,
  reusableCell: IBufferCell,
): TerminalCell {
  if (!line) {
    return blankCell();
  }

  const cell = line.getCell(col, reusableCell);
  if (!cell) {
    return blankCell();
  }

  const fgModeRaw = cell.getFgColorMode();
  const bgModeRaw = cell.getBgColorMode();
  const fgMode = fgModeRaw >> 24;
  const bgMode = bgModeRaw >> 24;
  const fg = fgMode !== 0 ? cell.getFgColor() : undefined;
  const bg = bgMode !== 0 ? cell.getBgColor() : undefined;

  return {
    char: cell.getChars() || " ",
    fg,
    bg,
    fgMode: fgMode !== 0 ? fgMode : undefined,
    bgMode: bgMode !== 0 ? bgMode : undefined,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    dim: cell.isDim() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}

function extractRow(
  terminal: HeadlessTerminalInstance,
  row: number,
  reusableCell: IBufferCell,
): TerminalCellRow {
  const line = terminal.buffer.active.getLine(row);
  const rowCells: TerminalCell[] = [];
  for (let col = 0; col < terminal.cols; col += 1) {
    rowCells.push(extractCell(line, col, reusableCell));
  }
  return rowCells;
}

function extractGrid(terminal: HeadlessTerminalInstance): TerminalCellRow[] {
  const grid: TerminalCellRow[] = [];
  const baseY = terminal.buffer.active.baseY;
  const reusableCell = terminal.buffer.active.getNullCell();
  for (let row = 0; row < terminal.rows; row += 1) {
    grid.push(extractRow(terminal, baseY + row, reusableCell));
  }
  return grid;
}

function extractScrollback(
  terminal: HeadlessTerminalInstance,
  options: { scrollbackLines?: number },
): TerminalCellRow[] {
  const scrollback: TerminalCellRow[] = [];
  const scrollbackLines = terminal.buffer.active.baseY;
  const startRow =
    typeof options.scrollbackLines === "number"
      ? Math.max(0, scrollbackLines - options.scrollbackLines)
      : 0;
  const reusableCell = terminal.buffer.active.getNullCell();

  for (let row = startRow; row < scrollbackLines; row += 1) {
    scrollback.push(extractRow(terminal, row, reusableCell));
  }

  return scrollback;
}

function extractBufferWindow(
  terminal: HeadlessTerminalInstance,
  input: TerminalBufferWindowInput,
): TerminalBufferWindow {
  const rowCount = Math.max(0, Math.floor(input.rowCount));
  const bufferLength = terminal.buffer.active.length;
  const startRow = Math.min(Math.max(0, Math.floor(input.startRow)), bufferLength);
  const endRow = Math.min(bufferLength, startRow + rowCount);
  const reusableCell = terminal.buffer.active.getNullCell();
  const rows: TerminalCellRow[] = [];
  const wrappedRows: boolean[] = [];

  for (let row = startRow; row < endRow; row += 1) {
    const line = terminal.buffer.active.getLine(row);
    rows.push(extractRow(terminal, row, reusableCell));
    wrappedRows.push(line?.isWrapped === true);
  }

  return { startRow, rows, wrappedRows };
}

function rowRange(firstRow: number, rowCount: number): TerminalRowRange {
  return {
    firstRow,
    lastRow: Math.max(firstRow, firstRow + Math.max(1, rowCount) - 1),
  };
}

function extractBufferBounds(
  terminal: HeadlessTerminalInstance,
  coordinateEpoch: number,
): TerminalBufferBounds {
  const buffer = terminal.buffer.active;
  const length = Math.max(1, buffer.length);
  const oldestRow = 0;
  const newestRow = length - 1;
  const bottomFirstRow = Math.max(oldestRow, newestRow - terminal.rows + 1);
  const currentFirstRow = Math.min(Math.max(oldestRow, buffer.baseY), bottomFirstRow);

  return {
    rows: terminal.rows,
    cols: terminal.cols,
    oldestRow,
    newestRow,
    coordinateEpoch,
    currentViewport: rowRange(currentFirstRow, terminal.rows),
    bottomViewport: rowRange(bottomFirstRow, terminal.rows),
    cursorRow: buffer.baseY + buffer.cursorY,
    cursorCol: buffer.cursorX,
  };
}

function extractCursorState(
  terminal: HeadlessTerminalInstance,
  window?: TerminalViewportStateInput,
): TerminalState["cursor"] {
  const coreService = (terminal as unknown as HeadlessTerminalWithCore)._core?.coreService;
  const cursorStyle = coreService?.decPrivateModes?.cursorStyle;
  const normalizedCursorStyle =
    cursorStyle === "block" || cursorStyle === "underline" || cursorStyle === "bar"
      ? cursorStyle
      : undefined;
  const cursorBlink =
    typeof coreService?.decPrivateModes?.cursorBlink === "boolean"
      ? coreService.decPrivateModes.cursorBlink
      : undefined;
  const cursorRow = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
  const relativeCursorRow = window ? cursorRow - window.firstRow : terminal.buffer.active.cursorY;
  const hiddenByWindow = window
    ? relativeCursorRow < 0 || relativeCursorRow >= Math.max(0, Math.floor(window.rowCount))
    : false;
  const hidden = Boolean(coreService?.isCursorHidden) || hiddenByWindow;

  return {
    row: relativeCursorRow,
    col: terminal.buffer.active.cursorX,
    ...(hidden ? { hidden: true } : {}),
    ...(normalizedCursorStyle ? { style: normalizedCursorStyle } : {}),
    ...(typeof cursorBlink === "boolean" ? { blink: cursorBlink } : {}),
  };
}

function extractInputModeState(
  terminal: HeadlessTerminalInstance,
): NativeHeadlessTerminalInputModeState {
  const coreService = (terminal as unknown as HeadlessTerminalWithCore)._core?.coreService;
  return {
    applicationCursorKeys: coreService?.decPrivateModes?.applicationCursorKeys === true,
    bracketedPaste: coreService?.decPrivateModes?.bracketedPasteMode === true,
  };
}

function extractState(
  terminal: HeadlessTerminalInstance,
  options: { scrollbackLines?: number },
): TerminalState {
  return {
    rows: terminal.rows,
    cols: terminal.cols,
    grid: extractGrid(terminal),
    scrollback: extractScrollback(terminal, options),
    cursor: extractCursorState(terminal),
  };
}

function extractViewportState(
  terminal: HeadlessTerminalInstance,
  coordinateEpoch: number,
  input?: TerminalViewportStateInput,
): TerminalViewportState {
  const bounds = extractBufferBounds(terminal, coordinateEpoch);
  const rowCount = input ? Math.max(0, Math.floor(input.rowCount)) : terminal.rows;
  const firstRow = input ? input.firstRow : bounds.currentViewport.firstRow;
  const window = extractBufferWindow(terminal, { startRow: firstRow, rowCount });
  return {
    rows: window.rows.length,
    cols: terminal.cols,
    firstRow: window.startRow,
    oldestRow: bounds.oldestRow,
    newestRow: bounds.newestRow,
    grid: window.rows,
    cursor: extractCursorState(terminal, {
      firstRow: window.startRow,
      rowCount: window.rows.length,
    }),
  };
}

export function createNativeHeadlessTerminal(
  options: NativeHeadlessTerminalOptions,
): NativeHeadlessTerminal {
  const terminal = new HeadlessTerminal({
    rows: options.rows,
    cols: options.cols,
    scrollback: options.scrollbackLines ?? 1000,
    allowProposedApi: true,
  });
  const decoder = new TextDecoder();
  let coordinateEpoch = 0;

  function maxBufferLength(): number {
    return terminal.rows + (options.scrollbackLines ?? 1000);
  }

  function updateCoordinateEpochAfterWrite(previousLength: number): void {
    const nextLength = terminal.buffer.active.length;
    if (nextLength < previousLength || nextLength >= maxBufferLength()) {
      coordinateEpoch += 1;
    }
  }

  return {
    async write(data: NativeTerminalWriteData): Promise<void> {
      const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
      if (text.length === 0) {
        return;
      }
      const previousLength = terminal.buffer.active.length;
      await new Promise<void>((resolve) => {
        terminal.write(text, () => {
          updateCoordinateEpochAfterWrite(previousLength);
          resolve();
        });
      });
    },
    getState(): TerminalState {
      return extractState(terminal, { scrollbackLines: options.scrollbackLines });
    },
    getViewportState(input?: TerminalViewportStateInput): TerminalViewportState {
      return extractViewportState(terminal, coordinateEpoch, input);
    },
    getInputModeState(): NativeHeadlessTerminalInputModeState {
      return extractInputModeState(terminal);
    },
    getBufferBounds(): TerminalBufferBounds {
      return extractBufferBounds(terminal, coordinateEpoch);
    },
    getBufferWindow(input: TerminalBufferWindowInput): TerminalBufferWindow {
      return extractBufferWindow(terminal, input);
    },
    resize(input: { rows: number; cols: number }): void {
      coordinateEpoch += 1;
      terminal.resize(input.cols, input.rows);
    },
    reset(): void {
      coordinateEpoch += 1;
      decoder.decode();
      terminal.reset();
    },
    dispose(): void {
      terminal.dispose();
    },
  };
}

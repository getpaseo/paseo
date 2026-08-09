import {
  Terminal as HeadlessTerminal,
  type IBufferCell,
  type IBufferLine,
  type Terminal as HeadlessTerminalInstance,
} from "@xterm/headless";
import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";

export type NativeTerminalWriteData = Uint8Array | string;
export interface NativeTerminalCell extends TerminalCell {
  width?: number;
}

export type TerminalCellRow = NativeTerminalCell[];

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
    _bufferService?: {
      buffer?: {
        lines?: {
          onTrim?: (listener: (amount: number) => void) => { dispose(): void };
        };
      };
    };
  };
}

interface TerminalCoordinateStorage {
  oldestRow: number;
  trimSubscription: { dispose(): void } | null;
}

function activeBufferLines(terminal: HeadlessTerminalInstance) {
  return (terminal as unknown as HeadlessTerminalWithCore)._core?._bufferService?.buffer?.lines;
}

function blankCell(): NativeTerminalCell {
  return { char: " ", width: 1, fg: undefined, bg: undefined };
}

function extractCell(
  line: IBufferLine | undefined,
  col: number,
  reusableCell: IBufferCell,
): NativeTerminalCell {
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
    width: cell.getWidth(),
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
  const rowCells: NativeTerminalCell[] = [];
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
  oldestRow: number,
  input: TerminalBufferWindowInput,
): TerminalBufferWindow {
  const rowCount = Math.max(0, Math.floor(input.rowCount));
  const bufferLength = terminal.buffer.active.length;
  const newestRow = oldestRow + bufferLength - 1;
  const startRow = Math.min(Math.max(oldestRow, Math.floor(input.startRow)), newestRow + 1);
  const endRow = Math.min(newestRow + 1, startRow + rowCount);
  const reusableCell = terminal.buffer.active.getNullCell();
  const rows: TerminalCellRow[] = [];
  const wrappedRows: boolean[] = [];

  for (let row = startRow; row < endRow; row += 1) {
    const bufferRow = row - oldestRow;
    const line = terminal.buffer.active.getLine(bufferRow);
    rows.push(extractRow(terminal, bufferRow, reusableCell));
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
  oldestRow: number,
): TerminalBufferBounds {
  const buffer = terminal.buffer.active;
  const length = Math.max(1, buffer.length);
  const newestRow = oldestRow + length - 1;
  const bottomFirstRow = Math.max(oldestRow, newestRow - terminal.rows + 1);
  const currentFirstRow = Math.min(Math.max(oldestRow, oldestRow + buffer.baseY), bottomFirstRow);

  return {
    rows: terminal.rows,
    cols: terminal.cols,
    oldestRow,
    newestRow,
    coordinateEpoch,
    currentViewport: rowRange(currentFirstRow, terminal.rows),
    bottomViewport: rowRange(bottomFirstRow, terminal.rows),
    cursorRow: oldestRow + buffer.baseY + buffer.cursorY,
    cursorCol: buffer.cursorX,
  };
}

function extractCursorState(
  terminal: HeadlessTerminalInstance,
  window?: TerminalViewportStateInput,
  oldestRow = 0,
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
  const cursorRow = oldestRow + terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
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
  oldestRow: number,
  input?: TerminalViewportStateInput,
): TerminalViewportState {
  const bounds = extractBufferBounds(terminal, coordinateEpoch, oldestRow);
  const rowCount = input ? Math.max(0, Math.floor(input.rowCount)) : terminal.rows;
  const firstRow = input ? input.firstRow : bounds.currentViewport.firstRow;
  const window = extractBufferWindow(terminal, oldestRow, { startRow: firstRow, rowCount });
  return {
    rows: window.rows.length,
    cols: terminal.cols,
    firstRow: window.startRow,
    oldestRow: bounds.oldestRow,
    newestRow: bounds.newestRow,
    grid: window.rows,
    cursor: extractCursorState(
      terminal,
      {
        firstRow: window.startRow,
        rowCount: window.rows.length,
      },
      oldestRow,
    ),
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
  const coordinateStorage = new Map<object, TerminalCoordinateStorage>();

  function getActiveCoordinateStorage(): TerminalCoordinateStorage {
    const lines = activeBufferLines(terminal);
    if (!lines) {
      throw new Error("Native terminal buffer storage is unavailable");
    }
    const existing = coordinateStorage.get(lines);
    if (existing) {
      return existing;
    }
    const storage: TerminalCoordinateStorage = { oldestRow: 0, trimSubscription: null };
    storage.trimSubscription =
      lines.onTrim?.((amount) => {
        storage.oldestRow += amount;
      }) ?? null;
    coordinateStorage.set(lines, storage);
    return storage;
  }

  getActiveCoordinateStorage();
  const bufferChangeSubscription = terminal.buffer.onBufferChange(() => {
    coordinateEpoch += 1;
    getActiveCoordinateStorage();
  });

  return {
    async write(data: NativeTerminalWriteData): Promise<void> {
      const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
      if (text.length === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        terminal.write(text, () => {
          resolve();
        });
      });
    },
    getState(): TerminalState {
      return extractState(terminal, { scrollbackLines: options.scrollbackLines });
    },
    getViewportState(input?: TerminalViewportStateInput): TerminalViewportState {
      return extractViewportState(
        terminal,
        coordinateEpoch,
        getActiveCoordinateStorage().oldestRow,
        input,
      );
    },
    getInputModeState(): NativeHeadlessTerminalInputModeState {
      return extractInputModeState(terminal);
    },
    getBufferBounds(): TerminalBufferBounds {
      return extractBufferBounds(terminal, coordinateEpoch, getActiveCoordinateStorage().oldestRow);
    },
    getBufferWindow(input: TerminalBufferWindowInput): TerminalBufferWindow {
      return extractBufferWindow(terminal, getActiveCoordinateStorage().oldestRow, input);
    },
    resize(input: { rows: number; cols: number }): void {
      coordinateEpoch += 1;
      terminal.resize(input.cols, input.rows);
    },
    reset(): void {
      coordinateEpoch += 1;
      decoder.decode();
      terminal.reset();
      getActiveCoordinateStorage().oldestRow = 0;
    },
    dispose(): void {
      bufferChangeSubscription.dispose();
      for (const storage of coordinateStorage.values()) {
        storage.trimSubscription?.dispose();
      }
      terminal.dispose();
    },
  };
}

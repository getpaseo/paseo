import type { NativeHeadlessTerminal } from "./headless-terminal-state";
import type { TerminalGridCellMetrics } from "./terminal-grid-metrics";

export interface TerminalBufferCoordinate {
  row: number;
  col: number;
}

export interface TerminalSelectionRange {
  start: TerminalBufferCoordinate;
  end: TerminalBufferCoordinate;
  coordinateEpoch: number;
}

export interface TerminalSelectionSnapshot {
  range: TerminalSelectionRange | null;
}

export interface TerminalSelectionBounds {
  oldestRow: number;
  newestRow: number;
  coordinateEpoch: number;
}

export interface TerminalSelectionModel {
  begin(input: TerminalSelectionUpdateInput): TerminalSelectionSnapshot;
  update(input: TerminalSelectionUpdateInput): TerminalSelectionSnapshot;
  clear(): TerminalSelectionSnapshot;
  sync(input: TerminalSelectionSyncInput): TerminalSelectionSnapshot;
  getSnapshot(): TerminalSelectionSnapshot;
}

export interface TerminalSelectionUpdateInput {
  coordinate: TerminalBufferCoordinate;
  bounds: TerminalSelectionBounds;
}

export interface TerminalSelectionSyncInput {
  bounds: TerminalSelectionBounds;
}

export interface TerminalSelectionNormalizeInput {
  anchor: TerminalBufferCoordinate;
  focus: TerminalBufferCoordinate;
  coordinateEpoch: number;
}

export interface TerminalSelectionPoint {
  x: number;
  y: number;
}

export interface TerminalSelectionViewport {
  firstRow: number;
  rows: number;
  cols: number;
}

export interface TerminalSelectionHitTestInput {
  point: TerminalSelectionPoint;
  metrics: TerminalGridCellMetrics;
  viewport: TerminalSelectionViewport;
}

export interface TerminalSelectionRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalSelectionRectsInput {
  selection: TerminalSelectionRange | null;
  viewport: TerminalSelectionViewport;
  metrics: TerminalGridCellMetrics;
}

export interface TerminalSelectedTextInput {
  terminal: NativeHeadlessTerminal;
  selection: TerminalSelectionRange | null;
}

export interface TerminalClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

export interface CopyTerminalSelectionInput extends TerminalSelectedTextInput {
  clipboard: TerminalClipboardWriter;
}

interface TerminalSelectionState {
  anchor: TerminalBufferCoordinate | null;
  range: TerminalSelectionRange | null;
}

function compareCoordinates(
  left: TerminalBufferCoordinate,
  right: TerminalBufferCoordinate,
): number {
  if (left.row !== right.row) {
    return left.row - right.row;
  }
  return left.col - right.col;
}

function clampCoordinate(
  coordinate: TerminalBufferCoordinate,
  bounds: TerminalSelectionBounds,
): TerminalBufferCoordinate {
  return {
    row: Math.min(bounds.newestRow, Math.max(bounds.oldestRow, Math.floor(coordinate.row))),
    col: Math.max(0, Math.floor(coordinate.col)),
  };
}

function rangeIsSafe(range: TerminalSelectionRange, bounds: TerminalSelectionBounds): boolean {
  return (
    range.coordinateEpoch === bounds.coordinateEpoch &&
    range.start.row >= bounds.oldestRow &&
    range.end.row <= bounds.newestRow
  );
}

export function normalizeTerminalSelection(
  input: TerminalSelectionNormalizeInput,
): TerminalSelectionRange {
  if (compareCoordinates(input.anchor, input.focus) <= 0) {
    return {
      start: input.anchor,
      end: input.focus,
      coordinateEpoch: input.coordinateEpoch,
    };
  }

  return {
    start: input.focus,
    end: input.anchor,
    coordinateEpoch: input.coordinateEpoch,
  };
}

export function hitTestTerminalSelectionCell(
  input: TerminalSelectionHitTestInput,
): TerminalBufferCoordinate | null {
  if (
    input.point.x < 0 ||
    input.point.y < 0 ||
    input.metrics.cellWidth <= 0 ||
    input.metrics.cellHeight <= 0
  ) {
    return null;
  }

  const localRow = Math.floor(input.point.y / input.metrics.cellHeight);
  const col = Math.floor(input.point.x / input.metrics.cellWidth);
  if (localRow < 0 || localRow >= input.viewport.rows || col < 0 || col >= input.viewport.cols) {
    return null;
  }

  return {
    row: input.viewport.firstRow + localRow,
    col,
  };
}

export function resolveTerminalSelectionRects(
  input: TerminalSelectionRectsInput,
): TerminalSelectionRect[] {
  const selection = input.selection;
  if (!selection) {
    return [];
  }

  const firstVisibleRow = input.viewport.firstRow;
  const lastVisibleRow = input.viewport.firstRow + input.viewport.rows - 1;
  const firstRow = Math.max(selection.start.row, firstVisibleRow);
  const lastRow = Math.min(selection.end.row, lastVisibleRow);
  const rects: TerminalSelectionRect[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    const startsOnThisRow = row === selection.start.row;
    const endsOnThisRow = row === selection.end.row;
    const startCol = startsOnThisRow ? selection.start.col : 0;
    const endCol = endsOnThisRow ? selection.end.col : input.viewport.cols - 1;
    const clampedStartCol = Math.min(input.viewport.cols - 1, Math.max(0, startCol));
    const clampedEndCol = Math.min(input.viewport.cols - 1, Math.max(0, endCol));
    if (clampedEndCol < clampedStartCol) {
      continue;
    }

    rects.push({
      key: `${row}:${clampedStartCol}:${clampedEndCol}`,
      x: clampedStartCol * input.metrics.cellWidth,
      y: (row - input.viewport.firstRow) * input.metrics.cellHeight,
      width: (clampedEndCol - clampedStartCol + 1) * input.metrics.cellWidth,
      height: input.metrics.cellHeight,
    });
  }

  return rects;
}

export function createTerminalSelectionModel(): TerminalSelectionModel {
  let state: TerminalSelectionState = { anchor: null, range: null };

  function snapshot(): TerminalSelectionSnapshot {
    return { range: state.range };
  }

  function setSelection(input: TerminalSelectionUpdateInput): TerminalSelectionSnapshot {
    const coordinate = clampCoordinate(input.coordinate, input.bounds);
    const anchor = state.anchor ?? coordinate;
    const range = normalizeTerminalSelection({
      anchor,
      focus: coordinate,
      coordinateEpoch: input.bounds.coordinateEpoch,
    });
    state = { anchor, range };
    return snapshot();
  }

  return {
    begin(input: TerminalSelectionUpdateInput): TerminalSelectionSnapshot {
      const coordinate = clampCoordinate(input.coordinate, input.bounds);
      state = {
        anchor: coordinate,
        range: normalizeTerminalSelection({
          anchor: coordinate,
          focus: coordinate,
          coordinateEpoch: input.bounds.coordinateEpoch,
        }),
      };
      return snapshot();
    },
    update(input: TerminalSelectionUpdateInput): TerminalSelectionSnapshot {
      return setSelection(input);
    },
    clear(): TerminalSelectionSnapshot {
      state = { anchor: null, range: null };
      return snapshot();
    },
    sync(input: TerminalSelectionSyncInput): TerminalSelectionSnapshot {
      if (!state.range || rangeIsSafe(state.range, input.bounds)) {
        return snapshot();
      }
      state = { anchor: null, range: null };
      return snapshot();
    },
    getSnapshot(): TerminalSelectionSnapshot {
      return snapshot();
    },
  };
}

export function extractTerminalSelectedText(input: TerminalSelectedTextInput): string {
  const selection = input.selection;
  if (!selection) {
    return "";
  }

  const bounds = input.terminal.getBufferBounds();
  if (!rangeIsSafe(selection, bounds)) {
    return "";
  }

  const rowCount = selection.end.row - selection.start.row + 1;
  const window = input.terminal.getBufferWindow({
    startRow: selection.start.row,
    rowCount,
  });
  let text = "";

  for (let offset = 0; offset < window.rows.length; offset += 1) {
    const row = window.startRow + offset;
    const cells = window.rows[offset] ?? [];
    const startsOnThisRow = row === selection.start.row;
    const endsOnThisRow = row === selection.end.row;
    const startCol = startsOnThisRow ? selection.start.col : 0;
    const endCol = endsOnThisRow ? selection.end.col : cells.length - 1;
    const selectedCells = cells.slice(Math.max(0, startCol), Math.max(0, endCol) + 1);
    const line = selectedCells.map((cell) => cell.char || " ").join("");
    if (offset > 0 && window.wrappedRows[offset] !== true) {
      text += "\n";
    }
    text += line.trimEnd();
  }

  return text;
}

export async function copyTerminalSelection(input: CopyTerminalSelectionInput): Promise<string> {
  const text = extractTerminalSelectedText({
    terminal: input.terminal,
    selection: input.selection,
  });
  if (text.length === 0) {
    return "";
  }

  await input.clipboard.writeText(text);
  return text;
}

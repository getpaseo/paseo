export interface TerminalGridProjectionCursor {
  row: number;
  col: number;
}

export interface TerminalGridProjectionInput {
  gridRows: number;
  gridCols: number;
  cursor: TerminalGridProjectionCursor;
  viewportWidth: number;
  viewportHeight: number;
  cellWidth: number;
  cellHeight: number;
}

export interface TerminalGridProjection {
  firstRow: number;
  visibleRows: number;
  firstCol: number;
  visibleCols: number;
  cursorRow: number;
  cursorCol: number;
}

export function resolveTerminalGridProjection(
  input: TerminalGridProjectionInput,
): TerminalGridProjection {
  const visibleRows = resolveVisibleCells({
    viewportSize: input.viewportHeight,
    cellSize: input.cellHeight,
    gridCells: input.gridRows,
  });
  const visibleCols = resolveVisibleCells({
    viewportSize: input.viewportWidth,
    cellSize: input.cellWidth,
    gridCells: input.gridCols,
  });
  const firstRow = resolveFirstVisibleRow({
    gridRows: input.gridRows,
    visibleRows,
    cursorRow: input.cursor.row,
  });
  const firstCol = 0;

  return {
    firstRow,
    visibleRows,
    firstCol,
    visibleCols,
    cursorRow: input.cursor.row - firstRow,
    cursorCol: input.cursor.col - firstCol,
  };
}

function resolveVisibleCells(input: {
  viewportSize: number;
  cellSize: number;
  gridCells: number;
}): number {
  if (input.viewportSize <= 0 || input.cellSize <= 0 || input.gridCells <= 0) {
    return 0;
  }
  return Math.min(input.gridCells, Math.max(1, Math.floor(input.viewportSize / input.cellSize)));
}

function resolveFirstVisibleRow(input: {
  gridRows: number;
  visibleRows: number;
  cursorRow: number;
}): number {
  const maxFirstRow = Math.max(0, input.gridRows - input.visibleRows);
  const cursorAnchoredRow = input.cursorRow - input.visibleRows + 1;
  return clamp(cursorAnchoredRow, 0, maxFirstRow);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

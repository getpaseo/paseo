import { fileAtDocumentOffset, fragmentWidthForRange } from "./model";
import type {
  DiffCell,
  DiffCharacterPosition,
  DiffDocumentModel,
  DiffHit,
  DiffSelection,
} from "./types";

const CODE_LEFT_PADDING = 8;

export function hitTestDiffDocument(input: {
  model: DiffDocumentModel;
  x: number;
  documentY: number;
  horizontalOffset: number;
}): DiffHit | null {
  const file = fileAtDocumentOffset(input.model.files, input.documentY);
  if (!file) return null;
  if (input.documentY < file.bodyTop) return { kind: "header", path: file.path };
  const row = rowAtOffset(input.model.rows, file.rowStart, file.rowEnd, input.documentY);
  if (!row || row.kind !== "line") return null;
  const textHeight = row.height - row.reviewHeight;
  if (input.documentY >= row.top + textHeight) return null;
  const columnCount = row.cells.length;
  const columnWidth = input.model.viewportWidth / columnCount;
  const cellIndex = Math.min(columnCount - 1, Math.max(0, Math.floor(input.x / columnWidth)));
  const cell = row.cells[cellIndex];
  if (!cell) return null;
  const localX = input.x - cellIndex * columnWidth;
  const contentX = Math.max(
    0,
    localX - file.gutterWidth - CODE_LEFT_PADDING + input.horizontalOffset,
  );
  const textY = input.documentY - row.top;
  const sourceOffset = characterOffsetAtPoint({
    cell,
    x: contentX,
    y: textY,
    lineHeight: input.model.lineHeight,
  });
  return {
    kind: "cell",
    target: cell.reviewTarget,
    position: {
      fileIndex: file.fileIndex,
      rowIndex: row.index,
      cellIndex,
      side: cell.reviewTarget?.side ?? (cellIndex === 0 ? "old" : "new"),
      sourceOffset,
    },
  };
}

export function characterOffsetAtPoint(input: {
  cell: DiffCell;
  x: number;
  y: number;
  lineHeight: number;
}): number {
  const fragmentIndex = Math.min(
    input.cell.fragments.length - 1,
    Math.max(0, Math.floor(input.y / input.lineHeight)),
  );
  const fragment = input.cell.fragments[fragmentIndex];
  if (!fragment) return 0;
  let width = 0;
  for (const grapheme of fragment.graphemes) {
    if (input.x <= width + grapheme.width / 2) return grapheme.start;
    width += grapheme.width;
  }
  return fragment.end;
}

function rowAtOffset(
  rows: readonly DiffDocumentModel["rows"][number][],
  start: number,
  end: number,
  documentY: number,
): DiffDocumentModel["rows"][number] | null {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = rows[middle];
    if (row && row.top + row.height <= documentY) low = middle + 1;
    else high = middle;
  }
  const row = rows[low];
  return row && row.top <= documentY && documentY < row.top + row.height ? row : null;
}

export function orderedSelection(selection: DiffSelection): {
  start: DiffCharacterPosition;
  end: DiffCharacterPosition;
} {
  return comparePosition(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

export function selectedSourceText(model: DiffDocumentModel, selection: DiffSelection): string {
  return selectedCellRanges(model, selection)
    .map(({ cell, start, end }) => cell.content.slice(start, end))
    .join("\n");
}

export function selectCellSource(
  model: DiffDocumentModel,
  position: DiffCharacterPosition,
): DiffSelection {
  const row = model.rows[position.rowIndex];
  const cell = row?.kind === "line" ? row.cells[position.cellIndex] : null;
  const end = cell?.content.length ?? position.sourceOffset;
  return {
    anchor: { ...position, sourceOffset: 0 },
    focus: { ...position, sourceOffset: end },
  };
}

export function selectAllSource(
  model: DiffDocumentModel,
  preferredPosition?: DiffCharacterPosition,
): DiffSelection | null {
  let first: DiffCharacterPosition | null = null;
  let last: DiffCharacterPosition | null = null;
  const preferredRow = preferredPosition ? model.rows[preferredPosition.rowIndex] : null;
  const preferredCell =
    preferredPosition && preferredRow?.kind === "line"
      ? preferredRow.cells[preferredPosition.cellIndex]
      : null;
  let splitCellIndex: number | null = null;
  if (model.layout === "split") {
    const hasNewSource = model.rows.some(
      (row) => row.kind === "line" && row.cells[1] && row.cells[1].type !== "header",
    );
    splitCellIndex = hasNewSource ? 1 : 0;
    if (preferredPosition && preferredCell && preferredCell.type !== "header") {
      splitCellIndex = preferredPosition.cellIndex;
    }
  }
  for (const row of model.rows) {
    if (row.kind !== "line") continue;
    row.cells.forEach((cell, cellIndex) => {
      if (!cell || (splitCellIndex !== null && cellIndex !== splitCellIndex)) return;
      const side = cell.reviewTarget?.side ?? (cellIndex === 0 ? "old" : "new");
      first ??= {
        fileIndex: row.fileIndex,
        rowIndex: row.index,
        cellIndex,
        side,
        sourceOffset: 0,
      };
      last = {
        fileIndex: row.fileIndex,
        rowIndex: row.index,
        cellIndex,
        side,
        sourceOffset: cell.content.length,
      };
    });
  }
  return first && last ? { anchor: first, focus: last } : null;
}

function comparePosition(left: DiffCharacterPosition, right: DiffCharacterPosition): number {
  return (
    left.rowIndex - right.rowIndex ||
    left.cellIndex - right.cellIndex ||
    left.sourceOffset - right.sourceOffset
  );
}

interface SelectedCellRange {
  cell: DiffCell;
  cellIndex: number;
  rowIndex: number;
  start: number;
  end: number;
}

function selectedCellRanges(
  model: DiffDocumentModel,
  selection: DiffSelection,
): SelectedCellRange[] {
  const { start, end } = orderedSelection(selection);
  const sameSplitSide = model.layout === "split" && start.cellIndex === end.cellIndex;
  const ranges: SelectedCellRange[] = [];
  for (let rowIndex = start.rowIndex; rowIndex <= end.rowIndex; rowIndex += 1) {
    const row = model.rows[rowIndex];
    if (!row || row.kind !== "line") continue;
    row.cells.forEach((cell, cellIndex) => {
      if (!cell || (sameSplitSide && cellIndex !== start.cellIndex)) return;
      const position = { rowIndex, cellIndex };
      if (compareCell(position, start) < 0 || compareCell(position, end) > 0) return;
      const rangeStart =
        rowIndex === start.rowIndex && cellIndex === start.cellIndex ? start.sourceOffset : 0;
      const rangeEnd =
        rowIndex === end.rowIndex && cellIndex === end.cellIndex
          ? end.sourceOffset
          : cell.content.length;
      ranges.push({ cell, cellIndex, rowIndex, start: rangeStart, end: rangeEnd });
    });
  }
  return ranges;
}

function compareCell(
  left: Pick<DiffCharacterPosition, "rowIndex" | "cellIndex">,
  right: Pick<DiffCharacterPosition, "rowIndex" | "cellIndex">,
): number {
  return left.rowIndex - right.rowIndex || left.cellIndex - right.cellIndex;
}

export function selectionRectangles(input: {
  model: DiffDocumentModel;
  selection: DiffSelection;
}): SelectionRectangle[] {
  const rectangles: SelectionRectangle[] = [];
  for (const range of selectedCellRanges(input.model, input.selection)) {
    const row = input.model.rows[range.rowIndex];
    if (!row || row.kind !== "line") continue;
    const file = input.model.files[row.fileIndex];
    if (!file) continue;
    const columnWidth = input.model.viewportWidth / row.cells.length;
    const cell = range.cell;
    for (const fragment of cell.fragments) {
      const partStart = Math.max(fragment.start, range.start);
      const partEnd = Math.min(fragment.end, range.end);
      if (partEnd <= partStart) continue;
      const before = fragmentWidthForRange(fragment, fragment.start, partStart);
      const selected = fragmentWidthForRange(fragment, partStart, partEnd);
      rectangles.push({
        x: range.cellIndex * columnWidth + file.gutterWidth + CODE_LEFT_PADDING + before,
        y: row.top + fragment.top,
        width: selected,
        height: input.model.lineHeight,
        fileIndex: row.fileIndex,
        clipX: range.cellIndex * columnWidth + file.gutterWidth + CODE_LEFT_PADDING,
        clipWidth: columnWidth - file.gutterWidth - CODE_LEFT_PADDING,
      });
    }
  }
  return rectangles;
}

interface SelectionRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  fileIndex: number;
  clipX: number;
  clipWidth: number;
}

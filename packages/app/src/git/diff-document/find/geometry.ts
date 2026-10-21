import type { DiffDocumentModel, DiffLineRow } from "../types";
import { cellRangeRectangles } from "../hit-testing";
import { FILE_HEADER_HEIGHT } from "../model";
import type { DiffMatch } from "./model";

export function planDiffMatchReveal(input: {
  top: number;
  height: number;
  lineHeight: number;
  viewportHeight: number;
  widgetHeight: number;
}): { placement: "top" | "bottom"; scrollTop: number } {
  const clearance = input.widgetHeight + 16;
  const placement = input.top < clearance + FILE_HEADER_HEIGHT ? "bottom" : "top";
  const topInset = placement === "top" ? clearance + FILE_HEADER_HEIGHT : FILE_HEADER_HEIGHT;
  const bottomInset = placement === "bottom" ? clearance : 0;
  const usableHeight = Math.max(input.lineHeight, input.viewportHeight - topInset - bottomInset);
  const scrollTop = Math.max(0, input.top - topInset - (usableHeight - input.height) / 2);
  return { placement, scrollTop };
}

export interface MatchRow {
  row: DiffLineRow;
  cellIndex: number;
}

export function locateDiffMatch(model: DiffDocumentModel, match: DiffMatch): MatchRow | null {
  const file = model.files.find((section) => section.file === match.file);
  if (!file || file.isCollapsed) return null;
  const type = match.file.hunks[match.hunkIndex].lines[match.lineIndex].type;
  const side = type === "remove" ? "old" : "new";
  for (let index = file.rowStart; index < file.rowEnd; index++) {
    const row = model.rows[index];
    if (row.kind !== "line") continue;
    const cellIndex = row.cells.findIndex(
      (cell) =>
        cell &&
        cell.sourceIdentity.hunkIndex === match.hunkIndex &&
        cell.sourceIdentity.lineIndex === match.lineIndex &&
        cell.sourceIdentity.side === side,
    );
    if (cellIndex !== -1) return { row, cellIndex };
  }
  return null;
}

export function diffMatchRectangles(model: DiffDocumentModel, match: DiffMatch) {
  const located = locateDiffMatch(model, match);
  if (!located) return [];
  return cellRangeRectangles({
    model,
    rowIndex: located.row.index,
    cellIndex: located.cellIndex,
    start: match.start,
    end: match.end,
  });
}

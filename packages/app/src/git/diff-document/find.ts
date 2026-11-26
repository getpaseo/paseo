import { DIFF_FILE_HEADER_LEFT, DIFF_FILE_HEADER_RIGHT } from "@/git/file-header-presentation";
import { selectedSourceText } from "./hit-testing";
import { fragmentWidthForRange } from "./model";
import type { DiffCell, DiffDocumentModel, DiffSelection, DiffSourceIdentity } from "./types";

export const DIFF_FIND_MATCH_LIMIT = 10_000;
const CODE_LEFT_PADDING = 8;

export interface DiffFindMatch {
  kind?: "cell" | "header";
  fileIndex: number;
  path: string;
  rowIndex: number;
  cellIndex: number;
  side: "old" | "new";
  sourceIdentity: DiffSourceIdentity;
  start: number;
  end: number;
}

export interface DiffHeaderFindSpan {
  start: number;
  end: number;
  active: boolean;
}

export interface DiffFindMatchesResult {
  matches: DiffFindMatch[];
  limited: boolean;
}

export interface DiffFindHighlightState {
  matches: readonly DiffFindMatch[];
  activeIndex: number;
}

export interface DiffFindRectangle {
  rowIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fileIndex: number;
  clipX: number;
  clipWidth: number;
  active: boolean;
}

function escapeLiteralPattern(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HEADER_SOURCE_IDENTITY: DiffSourceIdentity = {
  hunkIndex: -1,
  lineIndex: -1,
  side: "new",
};

function appendHeaderMatches(
  file: DiffDocumentModel["files"][number],
  expression: RegExp,
  matches: DiffFindMatch[],
  limit: number,
): boolean {
  if (file.headerHeight <= 0 || !file.path) return false;
  for (const match of file.path.matchAll(expression)) {
    if (match[0].length === 0) continue;
    if (matches.length === limit) return true;
    matches.push({
      kind: "header",
      fileIndex: file.fileIndex,
      path: file.path,
      rowIndex: file.rowStart,
      cellIndex: -1,
      side: "new",
      sourceIdentity: HEADER_SOURCE_IDENTITY,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return false;
}

function appendRowMatches(
  row: Extract<DiffDocumentModel["rows"][number], { kind: "line" }>,
  expression: RegExp,
  matches: DiffFindMatch[],
  limit: number,
): boolean {
  for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
    const cell = row.cells[cellIndex];
    if (!cell || !cell.content) continue;
    for (const match of cell.content.matchAll(expression)) {
      if (match[0].length === 0) continue;
      if (matches.length === limit) return true;
      matches.push({
        kind: "cell",
        fileIndex: row.fileIndex,
        path: row.path,
        rowIndex: row.index,
        cellIndex,
        side: cell.reviewTarget?.side ?? (cellIndex === 0 ? "old" : "new"),
        sourceIdentity: cell.sourceIdentity,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return false;
}

/**
 * Literal case-insensitive search across all file headers and loaded diff line cells in reading order.
 * Operates on `file.path` and `cell.content` directly so collapsed headers and offscreen unmaterialized rows are counted immediately.
 */
export function findDiffMatches(
  model: DiffDocumentModel,
  query: string,
  limit = DIFF_FIND_MATCH_LIMIT,
): DiffFindMatchesResult {
  if (!query) return { matches: [], limited: false };
  const expression = new RegExp(escapeLiteralPattern(query), "giu");
  const matches: DiffFindMatch[] = [];

  for (const file of model.files) {
    if (appendHeaderMatches(file, expression, matches, limit)) {
      return { matches, limited: true };
    }
    for (let rowIndex = file.rowStart; rowIndex < file.rowEnd; rowIndex += 1) {
      const row = model.rows[rowIndex];
      if (!row || row.kind !== "line") continue;
      if (appendRowMatches(row, expression, matches, limit)) {
        return { matches, limited: true };
      }
    }
  }

  return { matches, limited: false };
}

/**
 * Seeds Find from an active single-cell selection in the diff surface;
 * declines empty or multi-row selections.
 */
export function selectedSingleLineDiffText(
  model: DiffDocumentModel,
  selection: DiffSelection | null,
): string | null {
  if (!selection) return null;
  const { anchor, focus } = selection;
  if (
    anchor.rowIndex !== focus.rowIndex ||
    anchor.cellIndex !== focus.cellIndex ||
    anchor.sourceOffset === focus.sourceOffset
  ) {
    return null;
  }
  const text = selectedSourceText(model, selection);
  return text && !/[\r\n]/.test(text) ? text : null;
}

function lowerBoundMatchByRow(matches: readonly DiffFindMatch[], rowStart: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (matches[mid]!.rowIndex < rowStart) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lowerBoundMatchByFile(matches: readonly DiffFindMatch[], fileIndex: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (matches[mid]!.fileIndex < fileIndex) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Returns header path match spans for `fileIndex`.
 */
export function diffFindHeaderMatchesForFile(
  find: DiffFindHighlightState | null | undefined,
  fileIndex: number,
): DiffHeaderFindSpan[] {
  if (!find || find.matches.length === 0) return [];
  const spans: DiffHeaderFindSpan[] = [];
  for (
    let matchIndex = lowerBoundMatchByFile(find.matches, fileIndex);
    matchIndex < find.matches.length;
    matchIndex += 1
  ) {
    const match = find.matches[matchIndex]!;
    if (match.fileIndex !== fileIndex || match.kind !== "header") break;
    spans.push({
      start: match.start,
      end: match.end,
      active: matchIndex === find.activeIndex,
    });
  }
  return spans;
}

/**
 * Computes Canvas highlight rectangles for matches within `[rowStart, rowEnd)`.
 */
export function diffFindRectanglesForRowRange(input: {
  model: DiffDocumentModel;
  find: DiffFindHighlightState;
  rowStart: number;
  rowEnd: number;
}): DiffFindRectangle[] {
  const { model, find, rowStart, rowEnd } = input;
  if (find.matches.length === 0 || rowEnd <= rowStart) return [];

  const rectangles: DiffFindRectangle[] = [];
  for (
    let matchIndex = lowerBoundMatchByRow(find.matches, rowStart);
    matchIndex < find.matches.length;
    matchIndex += 1
  ) {
    const match = find.matches[matchIndex]!;
    if (match.rowIndex >= rowEnd) break;
    if (match.kind === "header") continue;
    const row = model.rows[match.rowIndex];
    if (!row || row.kind !== "line") continue;
    const file = model.files[row.fileIndex];
    const cell = row.cells[match.cellIndex];
    if (!file || !cell || cell.fragments.length === 0) continue;

    const columnWidth = model.viewportWidth / row.cells.length;
    const clipX = match.cellIndex * columnWidth + file.gutterWidth + CODE_LEFT_PADDING;
    const clipWidth = columnWidth - file.gutterWidth - CODE_LEFT_PADDING;
    if (clipWidth <= 0) continue;

    for (const fragment of cell.fragments) {
      const partStart = Math.max(fragment.start, match.start);
      const partEnd = Math.min(fragment.end, match.end);
      if (partEnd <= partStart) continue;
      const before = fragmentWidthForRange(fragment, fragment.start, partStart);
      const width = Math.max(1, fragmentWidthForRange(fragment, partStart, partEnd));
      rectangles.push({
        rowIndex: row.index,
        x: clipX + before,
        y: row.top + fragment.top,
        width,
        height: model.lineHeight,
        fileIndex: row.fileIndex,
        clipX,
        clipWidth,
        active: matchIndex === find.activeIndex,
      });
    }
  }
  return rectangles;
}

function estimatedDisplayOffset(text: string): number {
  return text.length + (text.match(/\t/g)?.length ?? 0) * 3;
}

function estimatedFragmentTop(cell: DiffCell, sourceOffset: number, lineHeight: number): number {
  const columns = cell.estimatedWrapColumns ?? Infinity;
  if (!Number.isFinite(columns) || columns <= 0) return 0;
  const visualLine = Math.floor(
    estimatedDisplayOffset(cell.content.slice(0, sourceOffset)) / columns,
  );
  return visualLine * lineHeight;
}

/**
 * Resolves the document-space vertical box `{ top, bottom, materialized }` and
 * optional horizontal metrics for a match, even before offscreen fragments materialize.
 */
export function resolveDiffMatchGeometry(
  model: DiffDocumentModel,
  match: DiffFindMatch,
): {
  top: number;
  bottom: number;
  materialized: boolean;
  screenLeft: (horizontalOffset: number) => number;
  screenRight: (horizontalOffset: number) => number;
  desiredHorizontalOffset: (currentOffset: number) => number;
} | null {
  if (match.kind === "header") {
    const file = model.files[match.fileIndex];
    if (!file || file.headerHeight <= 0) return null;
    const estimatedRight = Math.min(
      Math.max(DIFF_FILE_HEADER_LEFT + 1, model.viewportWidth - DIFF_FILE_HEADER_RIGHT),
      DIFF_FILE_HEADER_LEFT + Math.max(24, file.path.length * 8),
    );
    return {
      top: file.top,
      bottom: file.top + file.headerHeight,
      materialized: true,
      screenLeft: () => DIFF_FILE_HEADER_LEFT,
      screenRight: () => estimatedRight,
      desiredHorizontalOffset: (currentOffset) => currentOffset,
    };
  }

  const row = model.rows[match.rowIndex];
  if (!row || row.kind !== "line") return null;
  const file = model.files[row.fileIndex];
  const cell = row.cells[match.cellIndex];
  if (!file || !cell) return null;

  const columnWidth = model.viewportWidth / row.cells.length;
  const clipX = match.cellIndex * columnWidth + file.gutterWidth + CODE_LEFT_PADDING;
  const clipWidth = Math.max(0, columnWidth - file.gutterWidth - CODE_LEFT_PADDING);

  if (cell.fragments.length === 0) {
    const fragmentTop = estimatedFragmentTop(cell, match.start, model.lineHeight);
    const top = row.top + fragmentTop;
    return {
      top,
      bottom: top + model.lineHeight,
      materialized: false,
      screenLeft: () => clipX,
      screenRight: () => clipX + clipWidth,
      desiredHorizontalOffset: (currentOffset) => currentOffset,
    };
  }

  const fragment =
    cell.fragments.find((item) => item.start <= match.start && match.start < item.end) ??
    cell.fragments.at(-1)!;
  const partStart = Math.max(fragment.start, match.start);
  const partEnd = Math.min(fragment.end, match.end);
  const before = fragmentWidthForRange(fragment, fragment.start, partStart);
  const width = Math.max(
    1,
    partEnd > partStart ? fragmentWidthForRange(fragment, partStart, partEnd) : 1,
  );
  const top = row.top + fragment.top;

  return {
    top,
    bottom: top + model.lineHeight,
    materialized: true,
    screenLeft: (horizontalOffset) => clipX + before - (model.wrapLines ? 0 : horizontalOffset),
    screenRight: (horizontalOffset) =>
      clipX + before + width - (model.wrapLines ? 0 : horizontalOffset),
    desiredHorizontalOffset: (currentOffset) => {
      if (model.wrapLines || clipWidth <= 0) return 0;
      const padding = Math.min(24, clipWidth / 4);
      const visibleLeft = currentOffset + padding;
      const visibleRight = currentOffset + clipWidth - padding;
      const maxOffset = Math.max(0, file.contentWidth - model.viewportWidth);
      if (before < visibleLeft) {
        return Math.max(0, Math.min(maxOffset, before - padding));
      }
      if (before + width > visibleRight) {
        return Math.max(0, Math.min(maxOffset, before + width - clipWidth + padding));
      }
      return currentOffset;
    },
  };
}

export function sameDiffMatchIdentity(left: DiffFindMatch, right: DiffFindMatch): boolean {
  return (
    (left.kind ?? "cell") === (right.kind ?? "cell") &&
    left.path === right.path &&
    left.side === right.side &&
    left.sourceIdentity.hunkIndex === right.sourceIdentity.hunkIndex &&
    left.sourceIdentity.lineIndex === right.sourceIdentity.lineIndex &&
    left.start === right.start &&
    left.end === right.end
  );
}

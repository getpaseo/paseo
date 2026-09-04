import { lineNumberGutterWidth } from "@/components/code-insets";
import { findClusterBreak } from "@marijn/find-cluster-break";
import {
  buildSplitDiffRows,
  buildUnifiedDiffLines,
  type ReviewableDiffTarget,
  type SplitDiffDisplayLine,
} from "@/utils/diff-layout";
import { compactHighlightTokens } from "@/utils/diff-rendering";
import { getInlineReviewThreadState, getSplitInlineReviewThreadState } from "@/review/geometry";
import { advancesFor } from "./text-measurement";
import type {
  BuildDiffDocumentModelInput,
  DiffCell,
  DiffDocumentModel,
  DiffFileSection,
  DiffFragment,
  DiffGrapheme,
  DiffLineRow,
  DiffRow,
  DiffScrollAnchor,
  DiffSourceIdentity,
  DiffTokenRun,
  TextMeasurer,
} from "./types";

export const FILE_HEADER_HEIGHT = 30;
export const DIFF_BODY_BORDER_HEIGHT = 1;
const CODE_HORIZONTAL_PADDING = 16;

interface CellSource {
  type: DiffCell["type"];
  content: string;
  lineNumber: number | null;
  reviewTarget: ReviewableDiffTarget | null;
  tokenText: readonly { text: string; style?: string | null }[];
  sourceIdentity: DiffSourceIdentity;
}

interface GeometryLine {
  cells: DiffLineRow["cells"];
  reviewHeight: number;
  height: number;
}

interface ReusableModelIndex {
  model: DiffDocumentModel;
  filesBySource: Map<BuildDiffDocumentModelInput["files"][number], DiffFileSection>;
  measuredFiles: Set<DiffFileSection>;
}

interface ReusableFileRows {
  model: DiffDocumentModel;
  file: DiffFileSection;
}

interface FileRowsResult {
  bottom: number;
  maximumHorizontalOverflow: number;
}

export function buildDiffDocumentModel(input: BuildDiffDocumentModelInput): DiffDocumentModel {
  const rows: DiffRow[] = [];
  const files: DiffFileSection[] = [];
  const reusableModels = indexReusableModels(input.reuseFrom);
  const currentReviewGeometryKey = reviewGeometryKey(input.reviewActions);
  let documentTop = 0;

  for (const [fileIndex, file] of input.files.entries()) {
    const fileTop = documentTop;
    const isCollapsed = input.collapsedFilePaths.has(file.path);
    documentTop += FILE_HEADER_HEIGHT;
    const bodyTop = documentTop;
    const rowStart = rows.length;
    const gutterWidth = lineNumberGutterWidth(maximumLineNumber(file), input.typography.size);
    let maximumHorizontalOverflow = 0;

    const reusable = findReusableFileRows({
      indexes: reusableModels,
      buildInput: input,
      sourceFile: file,
      fileTop,
      bodyTop,
    });
    const reusableModel = reusable?.model;
    const reusableFile = reusable?.file;

    if (!isCollapsed) {
      const result =
        reusableModel && reusableFile
          ? appendReusableFileRows({
              rows,
              input,
              model: reusableModel,
              file: reusableFile,
              fileIndex,
              fileTop,
              bodyTop,
              reviewGeometryKey: currentReviewGeometryKey,
            })
          : appendNewFileRows({
              rows,
              input,
              file,
              fileIndex,
              fileTop,
              bodyTop,
              gutterWidth,
            });
      documentTop = result.bottom;
      maximumHorizontalOverflow = result.maximumHorizontalOverflow;
    }

    files.push({
      file,
      fileIndex,
      path: file.path,
      top: fileTop,
      headerHeight: FILE_HEADER_HEIGHT,
      bodyTop,
      bodyHeight: documentTop - bodyTop,
      bottom: documentTop,
      gutterWidth,
      contentWidth: input.wrapLines
        ? input.viewportWidth
        : input.viewportWidth + Math.max(0, maximumHorizontalOverflow),
      rowStart,
      rowEnd: rows.length,
      isCollapsed,
    });
  }

  return {
    files,
    rows,
    height: documentTop,
    lineHeight: input.typography.lineHeight,
    layout: input.layout,
    wrapLines: input.wrapLines,
    viewportWidth: input.viewportWidth,
    reviewGeometryKey: currentReviewGeometryKey,
  };
}

function appendReusableFileRows(candidate: {
  rows: DiffRow[];
  input: BuildDiffDocumentModelInput;
  model: DiffDocumentModel;
  file: DiffFileSection;
  fileIndex: number;
  fileTop: number;
  bodyTop: number;
  reviewGeometryKey: string;
}): FileRowsResult {
  const reusedRows = candidate.model.rows.slice(candidate.file.rowStart, candidate.file.rowEnd);
  const retainsRowGeometry =
    !candidate.input.wrapLines &&
    candidate.model.reviewGeometryKey === candidate.reviewGeometryKey &&
    candidate.file.top === candidate.fileTop &&
    candidate.file.rowStart === candidate.rows.length;
  if (retainsRowGeometry) {
    candidate.rows.push(...reusedRows);
    return {
      bottom: candidate.bodyTop + candidate.file.bodyHeight,
      maximumHorizontalOverflow: Math.max(
        0,
        candidate.file.contentWidth - candidate.input.viewportWidth,
      ),
    };
  }

  let top = candidate.bodyTop;
  for (const reusedRow of reusedRows) {
    const nextRow = repositionReusedRow(reusedRow, candidate, top);
    candidate.rows.push(nextRow);
    top += nextRow.height;
  }
  return {
    bottom: top + DIFF_BODY_BORDER_HEIGHT,
    maximumHorizontalOverflow: Math.max(
      0,
      candidate.file.contentWidth - candidate.input.viewportWidth,
    ),
  };
}

function repositionReusedRow(
  row: DiffRow,
  candidate: Pick<Parameters<typeof appendReusableFileRows>[0], "rows" | "input" | "fileIndex">,
  top: number,
): DiffRow {
  if (row.kind !== "line") {
    return { ...row, index: candidate.rows.length, fileIndex: candidate.fileIndex, top };
  }
  const reviewHeight = reviewHeightForCells(row.cells, candidate.input);
  return {
    ...row,
    index: candidate.rows.length,
    fileIndex: candidate.fileIndex,
    top,
    height: row.height - row.reviewHeight + reviewHeight,
    reviewHeight,
  };
}

function appendNewFileRows(candidate: {
  rows: DiffRow[];
  input: BuildDiffDocumentModelInput;
  file: BuildDiffDocumentModelInput["files"][number];
  fileIndex: number;
  fileTop: number;
  bodyTop: number;
  gutterWidth: number;
}): FileRowsResult {
  if (candidate.file.status === "binary" || candidate.file.status === "too_large") {
    const height = candidate.input.typography.lineHeight + 24;
    candidate.rows.push({
      kind: "status",
      index: candidate.rows.length,
      fileIndex: candidate.fileIndex,
      path: candidate.file.path,
      top: candidate.bodyTop,
      height,
      label:
        candidate.file.status === "binary"
          ? candidate.input.labels.binary
          : candidate.input.labels.tooLarge,
    });
    return {
      bottom: candidate.bodyTop + height + DIFF_BODY_BORDER_HEIGHT,
      maximumHorizontalOverflow: 0,
    };
  }

  const deferredLines =
    candidate.input.materializationWindow && !candidate.input.wrapLines
      ? geometryLines(lineSources(candidate.file, candidate.input.layout, false), candidate.input)
      : null;
  const deferredBodyHeight = deferredLines?.reduce((height, line) => height + line.height, 0) ?? 0;
  const shouldMaterialize =
    deferredLines === null ||
    intersectsMaterializationWindow(
      candidate.input,
      candidate.fileTop,
      candidate.bodyTop + deferredBodyHeight + DIFF_BODY_BORDER_HEIGHT,
    );
  return shouldMaterialize
    ? appendMeasuredFileRows(candidate)
    : appendGeometryFileRows(candidate, deferredLines);
}

function appendGeometryFileRows(
  candidate: Parameters<typeof appendNewFileRows>[0],
  lines: readonly GeometryLine[],
): FileRowsResult {
  let top = candidate.bodyTop;
  for (const line of lines) {
    candidate.rows.push({
      kind: "line",
      index: candidate.rows.length,
      fileIndex: candidate.fileIndex,
      path: candidate.file.path,
      top,
      height: line.height,
      cells: line.cells,
      reviewHeight: line.reviewHeight,
    });
    top += line.height;
  }
  return { bottom: top + DIFF_BODY_BORDER_HEIGHT, maximumHorizontalOverflow: 0 };
}

function appendMeasuredFileRows(
  candidate: Parameters<typeof appendNewFileRows>[0],
): FileRowsResult {
  let top = candidate.bodyTop;
  let maximumHorizontalOverflow = 0;
  for (const sourceCells of lineSources(candidate.file, candidate.input.layout, true)) {
    const columnCount = sourceCells.length;
    const columnWidth = candidate.input.viewportWidth / columnCount;
    const availableWidth = Math.max(
      candidate.input.measureText.measure("M"),
      columnWidth - candidate.gutterWidth - CODE_HORIZONTAL_PADDING,
    );
    const cells = sourceCells.map((source) => {
      if (!source) return null;
      const cell = measureCell({ source, availableWidth, input: candidate.input });
      maximumHorizontalOverflow = Math.max(
        maximumHorizontalOverflow,
        candidate.gutterWidth + CODE_HORIZONTAL_PADDING + measureCellWidth(cell) - columnWidth,
      );
      return cell;
    }) as DiffLineRow["cells"];
    const textHeight = Math.max(
      candidate.input.typography.lineHeight,
      ...cells.map((cell) => (cell?.fragments.length ?? 1) * candidate.input.typography.lineHeight),
    );
    const reviewHeight = reviewHeightForCells(cells, candidate.input);
    const height = textHeight + reviewHeight;
    candidate.rows.push({
      kind: "line",
      index: candidate.rows.length,
      fileIndex: candidate.fileIndex,
      path: candidate.file.path,
      top,
      height,
      cells,
      reviewHeight,
    });
    top += height;
  }
  return { bottom: top + DIFF_BODY_BORDER_HEIGHT, maximumHorizontalOverflow };
}

export function reviewGeometryKey(
  reviewActions: BuildDiffDocumentModelInput["reviewActions"],
): string {
  if (!reviewActions) return "";
  const comments = [...reviewActions.commentsByTarget.entries()]
    .map(([target, targetComments]) => [target, targetComments.map((comment) => comment.id).sort()])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const editor = reviewActions.editor
    ? [reviewActions.editor.target.key, reviewActions.editor.commentId]
    : null;
  return JSON.stringify([comments, editor]);
}

export function expandedBodyBorderTop(file: DiffFileSection): number | null {
  "worklet";
  return file.isCollapsed ? null : file.bottom - DIFF_BODY_BORDER_HEIGHT;
}

export function retainReusableModels(
  previous: readonly DiffDocumentModel[] | undefined,
  next: DiffDocumentModel,
): DiffDocumentModel[] {
  const fullest = [...(previous ?? []), next].reduce((best, candidate) =>
    measuredFileCount(candidate) > measuredFileCount(best) ? candidate : best,
  );
  return fullest === next ? [next] : [fullest, next];
}

function lineSources(
  file: BuildDiffDocumentModelInput["files"][number],
  layout: "unified" | "split",
  includeTokens: boolean,
): Array<[CellSource] | [CellSource | null, CellSource | null]> {
  if (layout === "split") {
    return buildSplitDiffRows(file).map((row) => {
      if (row.kind === "header") {
        return [headerSource(row.content, row.hunkIndex, row.lineIndex)];
      }
      return [cellSource(row.left, includeTokens), cellSource(row.right, includeTokens)];
    });
  }
  return buildUnifiedDiffLines(file).map((entry) => [
    {
      type: entry.line.type,
      content: entry.line.content,
      lineNumber: entry.lineNumber,
      reviewTarget: entry.reviewTarget,
      tokenText: includeTokens ? compactHighlightTokens(entry.line.tokens ?? []) : [],
      sourceIdentity: {
        hunkIndex: entry.hunkIndex,
        lineIndex: entry.lineIndex,
        side: entry.reviewTarget?.side ?? "new",
      },
    },
  ]);
}

function headerSource(content: string, hunkIndex: number, lineIndex: number): CellSource {
  return {
    type: "header",
    content,
    lineNumber: null,
    reviewTarget: null,
    tokenText: [],
    sourceIdentity: { hunkIndex, lineIndex, side: "new" },
  };
}

function cellSource(line: SplitDiffDisplayLine | null, includeTokens: boolean): CellSource | null {
  if (!line) return null;
  return {
    type: line.type,
    content: line.content,
    lineNumber: line.lineNumber,
    reviewTarget: line.reviewTarget,
    tokenText: includeTokens ? compactHighlightTokens(line.tokens ?? []) : [],
    sourceIdentity: {
      hunkIndex: line.hunkIndex,
      lineIndex: line.lineIndex,
      side: line.side,
    },
  };
}

function geometryCell(source: CellSource): DiffCell {
  return {
    type: source.type,
    content: source.content,
    lineNumber: source.lineNumber,
    tokens: [],
    fragments: [],
    reviewTarget: source.reviewTarget,
    sourceIdentity: source.sourceIdentity,
  };
}

function geometryLines(
  sources: Array<[CellSource] | [CellSource | null, CellSource | null]>,
  input: BuildDiffDocumentModelInput,
): GeometryLine[] {
  return sources.map((sourceCells) => {
    const cells = sourceCells.map((source) =>
      source ? geometryCell(source) : null,
    ) as DiffLineRow["cells"];
    const reviewHeight = reviewHeightForCells(cells, input);
    return {
      cells,
      reviewHeight,
      height: input.typography.lineHeight + reviewHeight,
    };
  });
}

function intersectsMaterializationWindow(
  input: BuildDiffDocumentModelInput,
  fileTop: number,
  fileBottom: number,
): boolean {
  const window = input.materializationWindow;
  if (!window) return true;
  return fileTop < window.top + window.height && fileBottom > window.top;
}

function hasMeasuredFileRows(model: DiffDocumentModel, file: DiffFileSection): boolean {
  if (file.isCollapsed) return false;
  return model.rows.slice(file.rowStart, file.rowEnd).every((row) => {
    if (row.kind !== "line") return true;
    return row.cells.every((cell) => !cell || cell.fragments.length > 0);
  });
}

function indexReusableModels(
  models: readonly DiffDocumentModel[] | undefined,
): ReusableModelIndex[] {
  return (models ?? []).map((model) => {
    const filesBySource = new Map<BuildDiffDocumentModelInput["files"][number], DiffFileSection>();
    const measuredFiles = new Set<DiffFileSection>();
    for (const file of model.files) {
      filesBySource.set(file.file, file);
      if (hasMeasuredFileRows(model, file)) measuredFiles.add(file);
    }
    return { model, filesBySource, measuredFiles };
  });
}

function findReusableFileRows(candidate: {
  indexes: readonly ReusableModelIndex[];
  buildInput: BuildDiffDocumentModelInput;
  sourceFile: BuildDiffDocumentModelInput["files"][number];
  fileTop: number;
  bodyTop: number;
}): ReusableFileRows | null {
  for (const index of candidate.indexes) {
    const file = index.filesBySource.get(candidate.sourceFile);
    if (
      file &&
      canReuseFileRows({
        buildInput: candidate.buildInput,
        file,
        isMeasured: index.measuredFiles.has(file),
        fileTop: candidate.fileTop,
        bodyTop: candidate.bodyTop,
      })
    ) {
      return { model: index.model, file };
    }
  }
  return null;
}

function canReuseFileRows(candidate: {
  buildInput: BuildDiffDocumentModelInput;
  file: DiffFileSection;
  isMeasured: boolean;
  fileTop: number;
  bodyTop: number;
}): boolean {
  if (candidate.file.isCollapsed) return false;
  if (candidate.isMeasured) return true;
  return !intersectsMaterializationWindow(
    candidate.buildInput,
    candidate.fileTop,
    candidate.bodyTop + candidate.file.bodyHeight,
  );
}

function measuredFileCount(model: DiffDocumentModel): number {
  return model.files.filter((file) => hasMeasuredFileRows(model, file)).length;
}

function measureCell(input: {
  source: CellSource;
  availableWidth: number;
  input: BuildDiffDocumentModelInput;
}): DiffCell {
  const fragments = measureFragments({
    text: input.source.content,
    availableWidth: input.availableWidth,
    wrapLines: input.input.wrapLines,
    lineHeight: input.input.typography.lineHeight,
    measureText: input.input.measureText,
  });
  return {
    type: input.source.type,
    content: input.source.content,
    lineNumber: input.source.lineNumber,
    tokens: tokenRuns(input.source, input.input.palette),
    fragments,
    reviewTarget: input.source.reviewTarget,
    sourceIdentity: input.source.sourceIdentity,
  };
}

function tokenRuns(
  source: CellSource,
  palette: BuildDiffDocumentModelInput["palette"],
): DiffTokenRun[] {
  const runs: DiffTokenRun[] = [];
  let offset = 0;
  for (const token of source.tokenText) {
    const end = offset + token.text.length;
    const color = token.style
      ? (palette.syntax[token.style] ?? palette.foreground)
      : palette.foreground;
    runs.push({ start: offset, end, color });
    offset = end;
  }
  return runs;
}

export function measureFragments(input: {
  text: string;
  availableWidth: number;
  wrapLines: boolean;
  lineHeight: number;
  measureText: TextMeasurer;
}): DiffFragment[] {
  const graphemes = segmentGraphemes(input.text);
  if (!input.wrapLines || input.text.length === 0) {
    return [createFragment(graphemes, 0, graphemes.length, 0, input.lineHeight, input.measureText)];
  }
  const fragments: DiffFragment[] = [];
  let graphemeIndex = 0;
  while (graphemeIndex < graphemes.length) {
    let low = graphemeIndex + 1;
    let high = graphemes.length;
    let fitting = low;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const width = measureGraphemeSlice(graphemes, graphemeIndex, middle, input.measureText).width;
      if (width <= input.availableWidth || middle === graphemeIndex + 1) {
        fitting = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    fragments.push(
      createFragment(
        graphemes,
        graphemeIndex,
        fitting,
        fragments.length,
        input.lineHeight,
        input.measureText,
      ),
    );
    graphemeIndex = fitting;
  }
  return fragments;
}

function createFragment(
  graphemes: Array<Omit<DiffGrapheme, "width">>,
  startIndex: number,
  endIndex: number,
  visualIndex: number,
  lineHeight: number,
  measureText: TextMeasurer,
): DiffFragment {
  const measured = measureGraphemeSlice(graphemes, startIndex, endIndex, measureText);
  const fragmentGraphemes = measured.graphemes;
  const start = fragmentGraphemes[0]?.start ?? 0;
  const end = fragmentGraphemes.at(-1)?.end ?? start;
  const top = visualIndex * lineHeight;
  return {
    start,
    end,
    text: fragmentGraphemes.map((grapheme) => grapheme.text).join(""),
    width: measured.width,
    top,
    baseline: top + lineHeight * 0.78,
    graphemes: fragmentGraphemes,
  };
}

const TAB_SIZE = 4;

function segmentGraphemes(text: string): Array<Omit<DiffGrapheme, "width">> {
  const segments: Array<Omit<DiffGrapheme, "width">> = [];
  let column = 0;
  for (let index = 0; index < text.length; ) {
    const end = findClusterBreak(text, index);
    const segment = text.slice(index, end);
    const isTab = segment === "\t";
    const spaces = isTab ? TAB_SIZE - (column % TAB_SIZE) : 0;
    const displayText = isTab ? " ".repeat(spaces) : segment;
    segments.push({
      start: index,
      end,
      text: displayText,
    });
    column += isTab ? spaces : 1;
    index = end;
  }
  return segments;
}

function measureGraphemeSlice(
  graphemes: Array<Omit<DiffGrapheme, "width">>,
  startIndex: number,
  endIndex: number,
  measureText: TextMeasurer,
): { graphemes: DiffGrapheme[]; width: number } {
  const segments = graphemes.slice(startIndex, endIndex);
  const displayGraphemes = segments.map((segment) => segment.text);
  const advances = advancesFor(measureText)(displayGraphemes);
  return {
    graphemes: segments.map((segment, index) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      width: (advances[index] ?? 0) - (advances[index - 1] ?? 0),
    })),
    width: advances.at(-1) ?? 0,
  };
}

export function fragmentTextForRange(fragment: DiffFragment, start: number, end: number): string {
  "worklet";
  return fragment.graphemes
    .filter((grapheme) => grapheme.start >= start && grapheme.end <= end)
    .map((grapheme) => grapheme.text)
    .join("");
}

export function fragmentWidthForRange(fragment: DiffFragment, start: number, end: number): number {
  return fragment.graphemes
    .filter((grapheme) => grapheme.start >= start && grapheme.end <= end)
    .reduce((width, grapheme) => width + grapheme.width, 0);
}

export function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  for (let index = 0; index < text.length; ) {
    index = findClusterBreak(text, index);
    boundaries.push(index);
  }
  return boundaries;
}

function measureCellWidth(cell: DiffCell): number {
  return Math.max(0, ...cell.fragments.map((part) => part.width));
}

function reviewHeightForCells(
  cells: DiffLineRow["cells"],
  input: BuildDiffDocumentModelInput,
): number {
  if (cells.length === 2) {
    return (
      getSplitInlineReviewThreadState({
        left: cells[0]?.reviewTarget,
        right: cells[1]?.reviewTarget,
        reviewActions: input.reviewActions,
      })?.height ?? 0
    );
  }
  return (
    getInlineReviewThreadState({
      reviewTarget: cells[0]?.reviewTarget,
      reviewActions: input.reviewActions,
    })?.height ?? 0
  );
}

function maximumLineNumber(file: BuildDiffDocumentModelInput["files"][number]): number {
  let maximum = 0;
  for (const hunk of file.hunks) {
    maximum = Math.max(maximum, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
  }
  return maximum;
}

export function visibleRowRange(
  rows: readonly DiffRow[],
  viewportTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  "worklet";
  const viewportBottom = viewportTop + viewportHeight;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = rows[middle];
    if (row && row.top + row.height <= viewportTop) low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = rows[middle];
    if (row && row.top < viewportBottom) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}

export function fileAtDocumentOffset(
  files: readonly DiffFileSection[],
  documentY: number,
): DiffFileSection | null {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const file = files[middle];
    if (file && file.bottom <= documentY) low = middle + 1;
    else high = middle;
  }
  return files[low] ?? null;
}

export function captureScrollAnchor(
  model: DiffDocumentModel,
  scrollTop: number,
): DiffScrollAnchor | null {
  const file = fileAtDocumentOffset(model.files, scrollTop);
  if (!file) return null;
  const row = model.rows
    .slice(file.rowStart, file.rowEnd)
    .find((candidate) => candidate.top + candidate.height > scrollTop);
  if (!row || row.kind !== "line") {
    return { kind: "header", path: file.path, viewportDelta: file.top - scrollTop };
  }
  const textY = Math.max(0, Math.min(scrollTop - row.top, row.height - row.reviewHeight));
  const visualIndex = Math.max(0, Math.floor(textY / model.lineHeight));
  let cellIndex = row.cells.findIndex((cell) => Boolean(cell?.fragments[visualIndex]));
  if (cellIndex < 0) cellIndex = row.cells.findIndex((cell) => cell !== null);
  const cell = row.cells[cellIndex];
  if (!cell) return { kind: "header", path: file.path, viewportDelta: row.top - scrollTop };
  const fragment = cell.fragments[Math.min(cell.fragments.length - 1, visualIndex)];
  const anchorY = row.top + (fragment?.top ?? 0);
  return {
    kind: "text",
    path: file.path,
    sourceIdentity: cell.sourceIdentity,
    cellOffset: fragment?.start ?? 0,
    viewportDelta: anchorY - scrollTop,
  };
}

export function resolveScrollAnchor(model: DiffDocumentModel, anchor: DiffScrollAnchor): number {
  const file = model.files.find((candidate) => candidate.path === anchor.path);
  if (!file) return 0;
  if (anchor.kind === "header") return Math.max(0, file.top - anchor.viewportDelta);
  const row = model.rows
    .slice(file.rowStart, file.rowEnd)
    .find(
      (candidate) =>
        candidate.kind === "line" &&
        candidate.cells.some(
          (cell) => cell && sameSourceIdentity(cell.sourceIdentity, anchor.sourceIdentity),
        ),
    );
  if (!row || row.kind !== "line") return Math.max(0, file.top - anchor.viewportDelta);
  const cell = row.cells.find(
    (candidate) => candidate && sameSourceIdentity(candidate.sourceIdentity, anchor.sourceIdentity),
  );
  if (!cell) return Math.max(0, row.top - anchor.viewportDelta);
  const fragment =
    cell.fragments.find(
      (candidate) => candidate.start <= anchor.cellOffset && anchor.cellOffset < candidate.end,
    ) ?? cell.fragments.at(-1);
  return Math.max(0, row.top + (fragment?.top ?? 0) - anchor.viewportDelta);
}

export function resolveRelayoutScrollTop(
  previous: DiffDocumentModel,
  next: DiffDocumentModel,
  scrollTop: number,
): number {
  const changedFiles = previous.files.filter((file) => {
    const nextFile = next.files.find((candidate) => candidate.path === file.path);
    return nextFile && nextFile.isCollapsed !== file.isCollapsed;
  });
  if (changedFiles.length === 1) {
    const previousFile = changedFiles[0]!;
    const nextFile = next.files.find((candidate) => candidate.path === previousFile.path);
    if (nextFile) {
      const headerDelta =
        previousFile.top <= scrollTop && scrollTop < previousFile.bottom
          ? 0
          : previousFile.top - scrollTop;
      return Math.max(0, nextFile.top - headerDelta);
    }
  }
  const anchor = captureScrollAnchor(previous, scrollTop);
  return anchor ? resolveScrollAnchor(next, anchor) : scrollTop;
}

export function shouldApplyRelayoutScroll(
  currentScrollTop: number,
  nextScrollTop: number,
): boolean {
  return Math.abs(nextScrollTop - currentScrollTop) > 0.5;
}

function sameSourceIdentity(left: DiffSourceIdentity, right: DiffSourceIdentity): boolean {
  return (
    left.hunkIndex === right.hunkIndex &&
    left.lineIndex === right.lineIndex &&
    left.side === right.side
  );
}

import { selectionRectangles } from "./hit-testing";
import {
  DIFF_BODY_BORDER_HEIGHT,
  expandedBodyBorderTop,
  fragmentWidthForRange,
  visibleRowRange,
} from "./model";
import { codeLineNumberTone, codeTextColor } from "./palette";
import { reviewBackgroundPaint, reviewDividerHeight, reviewGapTop } from "./review-paint";
import type {
  DiffCell,
  DiffDocumentModel,
  DiffLineRow,
  DiffPalette,
  DiffSelection,
  DiffTypography,
  TextMeasurer,
} from "./types";

const CODE_LEFT_PADDING = 8;

export interface PaintWebViewportInput {
  context: CanvasRenderingContext2D;
  model: DiffDocumentModel;
  palette: DiffPalette;
  typography: DiffTypography;
  measureText: TextMeasurer;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  horizontalOffsets: ReadonlyMap<string, number>;
  selection: DiffSelection | null;
  devicePixelRatio: number;
  paintTop?: number;
  paintHeight?: number;
}

export function paintWebViewport(input: PaintWebViewportInput): void {
  const { context } = input;
  const scale = input.devicePixelRatio;
  const paintTop = input.paintTop ?? 0;
  const paintHeight = input.paintHeight ?? input.viewportHeight;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.save();
  context.beginPath();
  context.rect(0, paintTop, input.viewportWidth, paintHeight);
  context.clip();
  context.clearRect(0, paintTop, input.viewportWidth, paintHeight);
  context.fillStyle = input.palette.surface;
  context.fillRect(0, paintTop, input.viewportWidth, paintHeight);
  context.font = `${input.typography.size}px ${input.typography.family}`;
  context.textBaseline = "alphabetic";

  const range = visibleRowRange(input.model.rows, input.scrollTop + paintTop, paintHeight);
  for (let index = range.start; index < range.end; index += 1) {
    const row = input.model.rows[index];
    if (!row) continue;
    const y = row.top - input.scrollTop;
    if (row.kind === "status") {
      context.fillStyle = input.palette.foregroundMuted;
      context.fillText(row.label, 12, y + input.model.lineHeight + 6);
      continue;
    }
    paintLine({
      ...input,
      row,
      y,
      horizontalOffset: input.horizontalOffsets.get(row.path) ?? 0,
    });
  }

  context.fillStyle = input.palette.border;
  const paintDocumentTop = input.scrollTop + paintTop;
  const paintDocumentBottom = paintDocumentTop + paintHeight;
  for (const file of input.model.files) {
    const borderTop = expandedBodyBorderTop(file);
    const isVisible =
      borderTop !== null &&
      borderTop < paintDocumentBottom &&
      borderTop + DIFF_BODY_BORDER_HEIGHT > paintDocumentTop;
    if (!isVisible) continue;
    context.fillRect(0, borderTop - input.scrollTop, input.viewportWidth, DIFF_BODY_BORDER_HEIGHT);
  }

  if (input.selection) paintSelection(input, input.selection);
  context.restore();
}

function paintLine(
  input: PaintWebViewportInput & {
    row: DiffLineRow;
    y: number;
    horizontalOffset: number;
  },
): void {
  const columnWidth = input.viewportWidth / input.row.cells.length;
  const file = input.model.files[input.row.fileIndex];
  if (!file) return;
  input.row.cells.forEach((cell, cellIndex) => {
    const x = cellIndex * columnWidth;
    input.context.fillStyle = cellBackground(cell, input.palette);
    input.context.fillRect(x, input.y, columnWidth, input.row.height);
    if (input.row.reviewHeight > 0) {
      input.context.fillStyle = reviewBackgroundPaint(input.palette.surface);
      input.context.fillRect(
        x,
        reviewGapTop(input.y, input.row.height, input.row.reviewHeight),
        columnWidth,
        input.row.reviewHeight,
      );
    }
    if (!cell) return;
    input.context.fillStyle = input.palette.border;
    input.context.fillRect(x + file.gutterWidth, input.y, 1, reviewDividerHeight(input.row.height));
    if (cell.lineNumber !== null) {
      const label = String(cell.lineNumber);
      input.context.fillStyle = lineNumberColor(cell, input.palette);
      input.context.fillText(
        label,
        x + file.gutterWidth - 7 - input.measureText.measure(label),
        input.y + input.model.lineHeight * 0.78,
      );
    }
    input.context.save();
    input.context.beginPath();
    input.context.rect(
      x + file.gutterWidth + CODE_LEFT_PADDING,
      input.y,
      columnWidth - file.gutterWidth - CODE_LEFT_PADDING,
      input.row.height - input.row.reviewHeight,
    );
    input.context.clip();
    paintCellText({ ...input, cell, x: x + file.gutterWidth + CODE_LEFT_PADDING });
    input.context.restore();
  });
}

function paintCellText(
  input: PaintWebViewportInput & {
    row: DiffLineRow;
    cell: DiffCell;
    x: number;
    y: number;
    horizontalOffset: number;
  },
): void {
  const offset = input.model.wrapLines ? 0 : input.horizontalOffset;
  for (const fragment of input.cell.fragments) {
    const baseline = input.y + fragment.baseline;
    const textX = input.x - offset;
    for (const band of fragmentColorBands(input.cell, fragment, input.palette)) {
      input.context.save();
      input.context.beginPath();
      input.context.rect(
        textX + band.x,
        input.y + fragment.top,
        band.width,
        input.model.lineHeight,
      );
      input.context.clip();
      input.context.fillStyle = band.color;
      // Keep the complete shaped string and origin used during measurement. Clipping changes
      // syntax color without breaking ligatures, kerning, or contextual forms into new runs.
      input.context.fillText(fragment.text, textX, baseline);
      input.context.restore();
    }
  }
}

function fragmentColorBands(
  cell: DiffCell,
  fragment: DiffCell["fragments"][number],
  palette: DiffPalette,
): Array<{ x: number; width: number; color: string }> {
  const ranges: Array<{ start: number; end: number; color: string }> = [];
  for (const grapheme of fragment.graphemes) {
    const syntaxRun = cell.tokens.find(
      (run) => run.start <= grapheme.start && grapheme.start < run.end,
    );
    const color = syntaxRun?.color ?? cellForeground(cell, palette);
    const previous = ranges.at(-1);
    if (previous?.color === color) previous.end = grapheme.end;
    else ranges.push({ start: grapheme.start, end: grapheme.end, color });
  }
  if (ranges.length === 0) {
    return [{ x: 0, width: Math.max(1, fragment.width), color: cellForeground(cell, palette) }];
  }
  return ranges.map((range) => ({
    x: fragmentWidthForRange(fragment, fragment.start, range.start),
    width: fragmentWidthForRange(fragment, range.start, range.end),
    color: range.color,
  }));
}

function paintSelection(input: PaintWebViewportInput, selection: DiffSelection): void {
  input.context.save();
  input.context.globalAlpha = 0.45;
  input.context.fillStyle = input.palette.selection;
  for (const rectangle of selectionRectangles({
    model: input.model,
    selection,
  })) {
    const file = input.model.files[rectangle.fileIndex];
    if (!file) continue;
    const x =
      rectangle.x - (input.model.wrapLines ? 0 : (input.horizontalOffsets.get(file.path) ?? 0));
    const y = rectangle.y - input.scrollTop;
    input.context.save();
    input.context.beginPath();
    input.context.rect(rectangle.clipX, y, rectangle.clipWidth, rectangle.height);
    input.context.clip();
    input.context.fillRect(x, y, rectangle.width, rectangle.height);
    input.context.restore();
  }
  input.context.restore();
}

function cellBackground(cell: DiffCell | null, palette: DiffPalette): string {
  if (!cell) return palette.emptyBackground;
  if (cell.type === "add") return palette.additionBackground;
  if (cell.type === "remove") return palette.deletionBackground;
  if (cell.type === "header") return palette.headerSurface;
  return palette.surface;
}

function cellForeground(cell: DiffCell, palette: DiffPalette): string {
  return codeTextColor(cell, palette);
}

function lineNumberColor(cell: DiffCell, palette: DiffPalette): string {
  return palette[codeLineNumberTone(cell)];
}

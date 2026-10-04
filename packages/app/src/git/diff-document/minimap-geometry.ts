import type { DiffCell, DiffDocumentModel } from "./types";

export type MinimapChange = "add" | "remove" | "modify";

export interface MinimapLine {
  top: number;
  height: number;
  change: MinimapChange | null;
  /** Leading whitespace in columns, tabs counted as four. */
  indent: number;
  /** Visible characters after the indent. */
  length: number;
}

export interface MinimapChangeRange {
  top: number;
  bottom: number;
  change: MinimapChange;
}

/** The densest a line may render, so a short file does not stretch into thick bars. */
export const MINIMAP_MAX_PIXELS_PER_LINE = 3;

export function buildMinimapLines(model: DiffDocumentModel): MinimapLine[] {
  const lines: MinimapLine[] = [];
  for (const row of model.rows) {
    if (row.kind !== "line") continue;
    const [first, second] = row.cells;
    const change = row.cells.length === 2 ? splitChange(first, second ?? null) : cellChange(first);
    if (change === undefined) continue;
    const source = (row.cells.length === 2 ? (second ?? first) : first) ?? null;
    const { indent, length } = measureShape(source?.content ?? "");
    lines.push({ top: row.top, height: row.height, change, indent, length });
  }
  return lines;
}

function cellChange(cell: DiffCell | null): MinimapChange | null | undefined {
  if (!cell || cell.type === "header") return undefined;
  if (cell.type === "add") return "add";
  if (cell.type === "remove") return "remove";
  return null;
}

function splitChange(
  left: DiffCell | null,
  right: DiffCell | null,
): MinimapChange | null | undefined {
  if (left?.type === "header" || right?.type === "header") return undefined;
  const removed = left?.type === "remove";
  const added = right?.type === "add";
  if (removed && added) return "modify";
  if (removed) return "remove";
  if (added) return "add";
  return null;
}

function measureShape(content: string): { indent: number; length: number } {
  let indent = 0;
  let index = 0;
  for (; index < content.length; index += 1) {
    const character = content[index];
    if (character === " ") indent += 1;
    else if (character === "\t") indent += 4;
    else break;
  }
  return { indent, length: content.trimEnd().length - index };
}

/** Adjacent changed lines of one kind merge into a single marker. */
export function buildMinimapChangeRanges(lines: readonly MinimapLine[]): MinimapChangeRange[] {
  const ranges: MinimapChangeRange[] = [];
  for (const line of lines) {
    if (!line.change) continue;
    const previous = ranges.at(-1);
    if (previous && previous.change === line.change && previous.bottom >= line.top) {
      previous.bottom = line.top + line.height;
      continue;
    }
    ranges.push({ top: line.top, bottom: line.top + line.height, change: line.change });
  }
  return ranges;
}

/** Document pixels to minimap pixels. */
export function minimapScale(input: {
  documentHeight: number;
  minimapHeight: number;
  lineHeight: number;
}): number {
  if (input.documentHeight <= 0 || input.minimapHeight <= 0) return 0;
  return Math.min(
    input.minimapHeight / input.documentHeight,
    MINIMAP_MAX_PIXELS_PER_LINE / Math.max(1, input.lineHeight),
  );
}

export function minimapSlider(input: {
  scale: number;
  scrollTop: number;
  viewportHeight: number;
}): { top: number; height: number } {
  return {
    top: input.scrollTop * input.scale,
    height: Math.max(8, input.viewportHeight * input.scale),
  };
}

/**
 * The scroll offset that puts minimap position `y` under the slider's grab point.
 * `grabOffset` is where inside the slider the pointer holds it.
 */
export function scrollTopForMinimapPointer(input: {
  y: number;
  grabOffset: number;
  scale: number;
  documentHeight: number;
  viewportHeight: number;
}): number {
  if (input.scale <= 0) return 0;
  const maximum = Math.max(0, input.documentHeight - input.viewportHeight);
  const requested = (input.y - input.grabOffset) / input.scale;
  return Math.min(maximum, Math.max(0, requested));
}

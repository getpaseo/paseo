import type { MatchRange } from "@getpaseo/protocol/search/text-match";

export interface HighlightSegment {
  /** Offset into the source text; unique per segment, so it doubles as a key. */
  start: number;
  text: string;
  marked: boolean;
}

/**
 * Splits text into marked and unmarked runs. Ranges are clamped and skipped
 * rather than trusted: they arrive over the wire, and a stale one must not slice
 * a title into gibberish.
 */
export function toHighlightSegments(
  text: string,
  ranges: readonly MatchRange[],
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(start + range.length, text.length);
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({ start: cursor, text: text.slice(cursor, start), marked: false });
    }
    segments.push({ start, text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ start: cursor, text: text.slice(cursor), marked: false });
  }
  return segments;
}

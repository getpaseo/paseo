import {
  fuzzyPolicyForToken,
  matchRanges,
  scoreMatch,
  tokenizeQuery,
  type MatchRange,
} from "@getpaseo/protocol/search/text-match";

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

/** Best-effort presentation of each query token in this field, independently of other fields. */
export function findHighlightRanges(query: string, text: string): MatchRange[] {
  const ranges = tokenizeQuery(query)
    .flatMap((token) => {
      const score = scoreMatch(token, text, { fuzzy: fuzzyPolicyForToken(token) });
      return score ? matchRanges(token, text, score) : [];
    })
    .sort((left, right) => left.start - right.start);
  const merged: MatchRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.start + last.length) {
      last.length = Math.max(last.length, range.start + range.length - last.start);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

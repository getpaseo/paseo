import { createContext, useContext } from "react";

/**
 * Shared "highlight the matched query" primitives used by both the timeline
 * search results panel and the rendered thread messages, so the term you
 * searched for is highlighted in the main timeline — not just the results list.
 */

export interface HighlightSegment {
  /** Start offset in the source text — stable, unique React key. */
  offset: number;
  text: string;
  isMatch: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the case-insensitive, Unicode-aware regex used to both detect and
 * highlight matches of `query` as a literal substring of `text`. Shared by
 * `textMatchesQuery` and `splitHighlightSegments` so detection and
 * highlighting never disagree — the "giu" regex Unicode case folding does
 * NOT always agree with `String.prototype.toLowerCase()` (e.g. Turkish
 * "İ".toLowerCase() contains "i", but /i/giu does not match "İ").
 */
function buildMatchExpression(trimmedQuery: string): RegExp {
  return new RegExp(escapeRegExp(trimmedQuery), "giu");
}

/**
 * Whether `text` contains `query` as a case-insensitive, Unicode-aware
 * substring match — using the SAME matching semantics as
 * `splitHighlightSegments`, so a match counted by detection is guaranteed to
 * actually highlight. Returns false when the trimmed query is empty.
 */
export function textMatchesQuery(text: string, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0 || text.length === 0) return false;
  return buildMatchExpression(trimmed).test(text);
}

/**
 * Locates the first case-insensitive, Unicode-aware match of `query` in
 * `text` — same matching semantics as `textMatchesQuery`/
 * `splitHighlightSegments`. Returns null when the trimmed query is empty or
 * there is no match. Used by `makeSnippet` to center a snippet on the match.
 */
export function findFirstMatch(
  text: string,
  query: string,
): { index: number; length: number } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || text.length === 0) return null;
  const match = buildMatchExpression(trimmed).exec(text);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

/**
 * Locates EVERY case-insensitive, Unicode-aware occurrence of `query` in
 * `text`, in order — same matching semantics as `textMatchesQuery`/
 * `splitHighlightSegments`, so every occurrence counted here also highlights.
 * Returns an empty array when the trimmed query is empty or there is no match.
 * Used by timeline search to make each occurrence its own navigable result.
 */
export function findAllMatches(
  text: string,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): Array<{ index: number; length: number }> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || text.length === 0 || limit <= 0) return [];
  const results: Array<{ index: number; length: number }> = [];
  for (const match of text.matchAll(buildMatchExpression(trimmed))) {
    results.push({ index: match.index, length: match[0].length });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Splits `text` into alternating non-match / match segments for `query`.
 * Case-insensitive; the query is treated as a literal (no regex). Returns a
 * single non-match segment when the query is empty or absent.
 *
 * Matching runs a case-insensitive regex over the ORIGINAL string so the
 * segment offsets are always valid indices into `text` — using
 * `toLowerCase()` offsets would break when a character's lowercase form has a
 * different length (e.g. Turkish "İ").
 */
export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim();
  if (trimmed.length === 0 || text.length === 0) {
    return [{ offset: 0, text, isMatch: false }];
  }
  const segments: HighlightSegment[] = [];
  const expression = buildMatchExpression(trimmed);
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    const start = match.index;
    if (start > cursor) {
      segments.push({ offset: cursor, text: text.slice(cursor, start), isMatch: false });
    }
    segments.push({ offset: start, text: match[0], isMatch: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ offset: cursor, text: text.slice(cursor), isMatch: false });
  }
  return segments;
}

/**
 * The active timeline-search query, propagated to the rendered thread so
 * message components can highlight occurrences. Empty string when the search
 * panel is closed, so highlighting is a no-op and adds no render cost.
 */
const TimelineHighlightContext = createContext<string>("");

export const TimelineHighlightProvider = TimelineHighlightContext.Provider;

export function useTimelineHighlightQuery(): string {
  return useContext(TimelineHighlightContext);
}

import { createContext, useContext } from "react";
import type { TimelineSearchTarget } from "./search-target";

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

/** A single located occurrence of a query within a text — named once and reused
 * across every match-locating function below instead of an inline object
 * shape at each call site. */
export interface TextMatchOccurrence {
  index: number;
  length: number;
}

// Single-entry cache: the timeline search panel re-evaluates the same query
// against many items in a row (once per stream item, per keystroke), so the
// overwhelmingly common case is "build this exact RegExp again". Caching only
// the LAST query keeps this a one-line lookup with no eviction policy, while
// still avoiding a fresh `RegExp` allocation (and its internal compile step)
// for every item. Safe to share the compiled RegExp across `.test()` and
// `.matchAll()` callers: `.matchAll()` operates on an internal clone (per
// spec) seeded from the current `lastIndex`, and `.test()` advances
// `lastIndex` on a global regex — so `lastIndex` is reset to 0 every time this
// function hands out the (possibly cached) RegExp, before the caller can
// observe or use it.
let cachedQuery: string | null = null;
let cachedExpression: RegExp | null = null;

/**
 * Builds the case-insensitive, Unicode-aware regex used to both detect and
 * highlight matches of `query` as a literal substring of `text`. Shared by
 * `textMatchesQuery` and `splitHighlightSegments` so detection and
 * highlighting never disagree — the "giu" regex Unicode case folding does
 * NOT always agree with `String.prototype.toLowerCase()` (e.g. Turkish
 * "İ".toLowerCase() contains "i", but /i/giu does not match "İ").
 */
function buildMatchExpression(trimmedQuery: string): RegExp {
  if (cachedQuery !== trimmedQuery || !cachedExpression) {
    cachedExpression = new RegExp(escapeRegExp(trimmedQuery), "giu");
    cachedQuery = trimmedQuery;
  }
  cachedExpression.lastIndex = 0;
  return cachedExpression;
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
): TextMatchOccurrence[] {
  const trimmed = query.trim();
  if (trimmed.length === 0 || text.length === 0 || limit <= 0) return [];
  const results: TextMatchOccurrence[] = [];
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
export interface TimelineHighlightState {
  query: string;
  target: TimelineSearchTarget | null;
}

const EMPTY_TIMELINE_HIGHLIGHT_STATE: TimelineHighlightState = { query: "", target: null };
const TimelineHighlightContext = createContext<TimelineHighlightState>(
  EMPTY_TIMELINE_HIGHLIGHT_STATE,
);

export const TimelineHighlightProvider = TimelineHighlightContext.Provider;

export function useTimelineHighlightQuery(): string {
  return useContext(TimelineHighlightContext).query;
}

/** The selected occurrence, if any. Kept separate from the query for exact active styling. */
export function useTimelineHighlightTarget(): TimelineSearchTarget | null {
  return useContext(TimelineHighlightContext).target;
}

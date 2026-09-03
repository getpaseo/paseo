import { capAssistantMessageForRender } from "@/components/assistant-message-render-limit";
import { foldFindText } from "@/find/dom/text-ranges";
import type { StreamItem } from "@/types/stream";
import { assistantPlainText } from "./plain-text";

export interface TranscriptFindItem {
  item: StreamItem;
  /**
   * True while the paced reveal is still painting the item. Its DOM holds a prefix of
   * the text, so indexing it would count matches the reader cannot see or scroll to.
   */
  isStreaming: boolean;
}

export interface TranscriptFindIndexEntry {
  itemId: string;
  count: number;
  /** Matches in earlier rows, so a global match index is `offset + occurrence`. */
  offset: number;
}

export interface TranscriptFindIndex {
  total: number;
  /** Every item in render order, including the ones with no matches. */
  entries: readonly TranscriptFindIndexEntry[];
}

export interface TranscriptFindMatch {
  itemId: string;
  occurrence: number;
}

export const EMPTY_TRANSCRIPT_FIND_INDEX: TranscriptFindIndex = { total: 0, entries: [] };

/**
 * The text a stream item paints, or "" for the kinds find deliberately skips.
 *
 * Tool calls, thoughts, activity logs and todo lists are collapsed, paginated or
 * summarized in ways the index cannot follow, so they are neither counted nor marked.
 */
export function searchableText(item: StreamItem): string {
  if (item.kind === "user_message") {
    return item.text;
  }
  if (item.kind === "assistant_message") {
    // The renderer caps what it paints; text past the cap has no DOM to highlight.
    return assistantPlainText(capAssistantMessageForRender(item.text).text);
  }
  return "";
}

/**
 * Folding an assistant message means parsing its markdown, which is far too expensive
 * to redo for every item on every keystroke. Stream items are replaced rather than
 * mutated when their text changes, but the live one is not, so the source text is
 * kept alongside the projection and checked.
 */
const foldedTextCache = new WeakMap<StreamItem, { source: string; folded: string }>();

function foldedSearchableText(item: StreamItem): string {
  if (item.kind !== "user_message" && item.kind !== "assistant_message") {
    return "";
  }
  const cached = foldedTextCache.get(item);
  if (cached?.source === item.text) {
    return cached.folded;
  }
  const folded = foldFindText(searchableText(item));
  foldedTextCache.set(item, { source: item.text, folded });
  return folded;
}

export function buildTranscriptFindIndex(
  items: readonly TranscriptFindItem[],
  query: string,
): TranscriptFindIndex {
  const needle = foldFindText(query);
  const entries: TranscriptFindIndexEntry[] = [];
  let total = 0;
  for (const { item, isStreaming } of items) {
    const count =
      needle === "" || isStreaming ? 0 : countOccurrences(foldedSearchableText(item), needle);
    entries.push({ itemId: item.id, count, offset: total });
    total += count;
  }
  return { total, entries };
}

/** The row a global match index lives in, and which of that row's matches it is. */
export function resolveMatch(index: TranscriptFindIndex, k: number): TranscriptFindMatch | null {
  if (k < 0 || k >= index.total) {
    return null;
  }
  // The last entry starting at or before k is the one that contains it: the next
  // entry starts at this entry's offset plus its count, which is already past k.
  let low = 0;
  let high = index.entries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (index.entries[middle].offset <= k) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const entry = index.entries[low];
  return { itemId: entry.itemId, occurrence: k - entry.offset };
}

/** The inverse of `resolveMatch`, used to keep the active match across a rebuild. */
export function locate(
  index: TranscriptFindIndex,
  itemId: string,
  occurrence: number,
): number | null {
  const entry = index.entries.find((candidate) => candidate.itemId === itemId);
  if (!entry || occurrence < 0 || occurrence >= entry.count) {
    return null;
  }
  return entry.offset + occurrence;
}

/**
 * The first match in `rowId` or in any row below it, so a fresh query activates what
 * the reader is looking at instead of jumping to the top of the history. Null when
 * the row is unknown or nothing below it matches; the caller wraps.
 */
export function firstMatchAtOrAfter(index: TranscriptFindIndex, rowId: string): number | null {
  const start = index.entries.findIndex((entry) => entry.itemId === rowId);
  if (start === -1) {
    return null;
  }
  for (let position = start; position < index.entries.length; position += 1) {
    const entry = index.entries[position];
    if (entry.count > 0) {
      return entry.offset;
    }
  }
  return null;
}

/** Non-overlapping, matching how find/dom/text-ranges walks the DOM. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

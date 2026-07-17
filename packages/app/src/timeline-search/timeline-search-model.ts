/**
 * timeline-search-model.ts
 *
 * Pure, framework-free model for the timeline find panel.
 * Searches the StreamItem[] supplied by its caller. The React binding pages
 * older history into that array while a query is active; this model remains
 * framework-free and performs no server RPCs itself.
 *
 * Filter semantics:
 *   all        — every searchable kind
 *   prompts    — user_message only (what you typed)
 *   messages   — assistant_message + thought + todo_list (what the agent produced)
 *   toolCalls  — tool call NAME + INPUT fields only (not outputs)
 *   toolOutput — tool call OUTPUT fields from COMPLETED calls only
 *   errors     — failed/canceled tool calls + activity_log with type "error"
 *
 * Scroll-to-result:
 *   The model itself has no notion of scrolling — it only tracks matches and
 *   a selectedIndex. `agent-stream/view.tsx` watches selectedIndex and asks
 *   the active render strategy's StreamViewportHandle.scrollToItem(itemId) to
 *   bring the match into view, via resolve-scroll-target.ts:
 *     - live-head items (not yet part of persisted history) fall back to
 *       scrollToBottom, since they always render adjacent to it;
 *     - items inside a collapsed tool-call group are unreachable as their own
 *       row until the group is expanded, so the group is expanded first and
 *       the scroll targets the group's host row;
 *     - everything else scrolls directly to its own row.
 *   Each render strategy (native FlatList, web virtualized/mounted DOM)
 *   implements scrollToItem for its own rendering model and reports whether
 *   the item was actually found and scrolled to.
 *   Not covered: a matched tool call's own inline detail/output body (as
 *   opposed to the group it may belong to) is not force-expanded — the row
 *   is scrolled to and visible, but its collapsed detail content may still
 *   need a manual tap, since that expand state is owned internally by the
 *   ToolCall component with no controlled override.
 */

import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import { findAllMatches, type TextMatchOccurrence } from "./highlight";

// ---- Filter types ----

export type TimelineSearchFilter =
  | "all"
  | "prompts"
  | "messages"
  | "thinking"
  | "toolCalls"
  | "toolOutput"
  | "errors";

// ---- Field-span registry ----

/**
 * Identifies WHICH rendered surface within a stream item a match belongs to.
 * The model searches one concatenated string per item (see
 * `extractSearchSpans`), but renderers display individual fields — a
 * `matchOffset` into that concatenated string is meaningless to a component
 * that only has one field's own text on hand. `TimelineSearchField` plus a
 * field-relative offset (`TimelineSearchMatch.fieldOffset`) is what lets a
 * renderer map a match back onto the text it actually owns.
 *
 * "text" / "tool" / "other" are the original coarse, per-item-kind values
 * (kept so existing call sites that hardcode one of them as a default/prop
 * type still compile); "toolInput" / "toolOutput" / "toolError" subdivide a
 * tool call's own detail into its input, output, and error surfaces; a
 * `todo:${index}` field is stamped per todo-list entry so a per-row surface
 * can map a match onto the specific row it occurred in.
 */
export type TimelineSearchField =
  | "text"
  | "tool"
  | "toolInput"
  | "toolOutput"
  | "toolError"
  | "other"
  | `todo:${number}`;

/** One field's contribution to an item's concatenated searchable text. */
export interface TimelineSearchFieldSpan {
  field: TimelineSearchField;
  /** Inclusive start offset of this field's text within the concatenated string. */
  start: number;
  /** Exclusive end offset of this field's text within the concatenated string. */
  end: number;
}

/** An ordered field part, before it's joined into the concatenated searchable string. */
interface TimelineSearchFieldPart {
  field: TimelineSearchField;
  text: string;
}

/** Result of extracting an item's searchable text, with per-field span boundaries. */
export interface TimelineSearchExtraction {
  text: string;
  spans: TimelineSearchFieldSpan[];
}

// ---- Match types ----

export interface TimelineSearchMatch {
  /** The stream item that matched. */
  item: StreamItem;
  /** The field-span this occurrence's start offset falls within (see `TimelineSearchField`). */
  field: TimelineSearchField;
  /**
   * Character offset of this occurrence within its OWN field's text — i.e.
   * `matchOffset` minus the containing span's `start`. This is what a
   * renderer that owns a single field's raw text should slice against.
   * A match spanning two fields is attributed to whichever field contains
   * its START offset (the simplest well-defined rule); if no span contains
   * the start (e.g. the match falls on the space joining two fields), this
   * falls back to the unadjusted `matchOffset`.
   */
  fieldOffset: number;
  /** Snippet for display (truncated to ~80 chars), centered on this occurrence. */
  snippet: string;
  /** Character offset of this occurrence within `snippet`. */
  snippetMatchOffset: number;
  /** Character length of this occurrence within `snippet`. */
  snippetMatchLength: number;
  /**
   * Character offset of this occurrence within the item's searchable text.
   * A single item yields one match PER occurrence, so a message containing the
   * query twice produces two navigable matches (distinguished by this offset).
   */
  matchOffset: number;
  /** Character length of this occurrence in the searchable source text. */
  matchLength: number;
  /** 0-based index of this occurrence among all matches within the same item. */
  occurrenceIndex: number;
}

// ---- Model state ----

export interface TimelineSearchState {
  query: string;
  filter: TimelineSearchFilter;
  matches: TimelineSearchMatch[];
  /** True when more occurrences exist beyond the bounded result list. */
  isMatchLimitExceeded: boolean;
  /** Zero-based index into `matches`; -1 when no matches or query is empty. */
  selectedIndex: number;
  isOpen: boolean;
  /**
   * Increments on every explicit navigation action (open/selectNext/
   * selectPrev/selectIndex) — including when the computed index equals the
   * current one (e.g. Enter with a single match). Consumers that need to
   * scroll to the current match (use-timeline-search-scroll.ts) should key
   * off this revision instead of `matches` identity, since `matches` is
   * rebuilt on every `refresh()` call while the panel is open and streaming
   * content arrives — that must never trigger a scroll on its own.
   */
  navigationRevision: number;
}

// ---- Text extraction helpers ----

/**
 * Builds the INPUT portion of a ToolCallDetail as ordered field parts: the
 * tool name (field "tool") followed by its detail-specific input arguments
 * (field "toolInput"). This is what the `toolCalls` filter searches.
 */
// oxlint-disable-next-line complexity
function buildDetailInputParts(name: string, detail: ToolCallDetail): TimelineSearchFieldPart[] {
  const parts: TimelineSearchFieldPart[] = [{ field: "tool", text: name }];
  switch (detail.type) {
    case "shell":
      parts.push({ field: "toolInput", text: detail.command });
      if (detail.cwd) parts.push({ field: "toolInput", text: detail.cwd });
      break;
    case "read":
      parts.push({ field: "toolInput", text: detail.filePath });
      break;
    case "edit":
      parts.push({ field: "toolInput", text: detail.filePath });
      if (detail.oldString) parts.push({ field: "toolInput", text: detail.oldString });
      if (detail.newString) parts.push({ field: "toolInput", text: detail.newString });
      break;
    case "write":
      parts.push({ field: "toolInput", text: detail.filePath });
      if (detail.content) parts.push({ field: "toolInput", text: detail.content });
      break;
    case "search":
      parts.push({ field: "toolInput", text: detail.query });
      if (detail.filePaths) parts.push({ field: "toolInput", text: detail.filePaths.join(" ") });
      break;
    case "fetch":
      parts.push({ field: "toolInput", text: detail.url });
      if (detail.prompt) parts.push({ field: "toolInput", text: detail.prompt });
      break;
    case "sub_agent":
      if (detail.description) parts.push({ field: "toolInput", text: detail.description });
      break;
    case "plan":
      parts.push({ field: "toolInput", text: detail.text });
      break;
    case "plain_text":
      if (detail.label) parts.push({ field: "toolInput", text: detail.label });
      if (detail.text) parts.push({ field: "toolInput", text: detail.text });
      break;
    case "worktree_setup":
      parts.push({ field: "toolInput", text: detail.worktreePath });
      parts.push({ field: "toolInput", text: detail.branchName });
      break;
    case "unknown":
      if (detail.input != null) {
        const stringified = safeStringify(detail.input);
        if (stringified) parts.push({ field: "toolInput", text: stringified });
      }
      break;
  }
  return parts.filter((part) => part.text.length > 0);
}

/**
 * Extract the OUTPUT portion of a ToolCallDetail: what the tool returned.
 * This is what `toolOutput` filter searches. Only meaningful for completed calls.
 */
// oxlint-disable-next-line complexity
function extractDetailOutput(detail: ToolCallDetail): string | null {
  switch (detail.type) {
    case "shell":
      return detail.output ?? null;
    case "read":
      return detail.content ?? null;
    case "search":
      return detail.content ?? null;
    case "fetch":
      return detail.result ?? null;
    case "sub_agent":
      return detail.log ?? null;
    case "worktree_setup":
      return detail.log ?? null;
    case "plain_text":
      return detail.text ?? null;
    case "plan":
      return null; // plan text is input
    case "edit":
    case "write":
      return null; // edits/writes have no meaningful output to search
    case "unknown":
      return detail.output != null ? (safeStringify(detail.output) ?? null) : null;
    default:
      return null;
  }
}

/** Stable identity for a single occurrence-level match (item + occurrence). */
export function matchKey(match: TimelineSearchMatch): string {
  return `${match.item.id}:${match.matchOffset}`;
}

/**
 * Whether `a` and `b` contain the same occurrence-level matches, in the same
 * order — keyed by item id AND match offset so two occurrences within one item
 * are treated as distinct (a streaming refresh that only appends new content
 * keeps the existing matches' identity and skips a re-notify/scroll).
 */
function matchesAreIdEqual(
  a: readonly TimelineSearchMatch[],
  b: readonly TimelineSearchMatch[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (matchKey(left) !== matchKey(right)) return false;
  }
  return true;
}

function safeStringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const SNIPPET_MAX_LENGTH = 80;
const SNIPPET_HEAD_ANCHOR_THRESHOLD = 80;
const SNIPPET_CONTEXT_BEFORE = 30;

/**
 * Builds a display snippet centered on a SPECIFIC occurrence, given the
 * pre-computed whitespace-collapsed text and that occurrence's position
 * ALREADY MAPPED into cleaned-text coordinates (see `collapseWhitespace`), so
 * each per-occurrence result shows its own surrounding context rather than
 * repeating the first match. A match that starts within the first
 * `SNIPPET_HEAD_ANCHOR_THRESHOLD` chars keeps the head-anchored behavior
 * (truncate from the start); a deeper match instead takes a window of
 * `SNIPPET_CONTEXT_BEFORE` chars before the match, filled out to
 * ~`SNIPPET_MAX_LENGTH` chars total, with a leading "…" (and trailing "…" if
 * the window doesn't reach the end of the text).
 *
 * The caller must pass the occurrence's OWN mapped position, not re-locate it
 * by searching `cleaned` independently: whitespace-collapsing is lossy for a
 * query that itself contains whitespace (e.g. collapsing "foo\nbar" produces
 * the same "foo bar" text as a literal "foo bar" occurrence elsewhere), so a
 * second independent search of `cleaned` can find a DIFFERENT number of
 * matches, in a different order, than the original text — pairing results by
 * index would then silently center the wrong occurrence.
 */
interface TimelineSearchSnippet {
  text: string;
  matchOffset: number;
  matchLength: number;
}

function makeSnippetFromCleaned(
  cleaned: string,
  cleanedMatch: TextMatchOccurrence,
): TimelineSearchSnippet {
  if (cleanedMatch.index < SNIPPET_HEAD_ANCHOR_THRESHOLD) {
    return {
      text: `${cleaned.slice(0, SNIPPET_MAX_LENGTH - 3)}…`,
      matchOffset: cleanedMatch.index,
      matchLength: cleanedMatch.length,
    };
  }

  const start = Math.max(0, cleanedMatch.index - SNIPPET_CONTEXT_BEFORE);
  const end = Math.min(cleaned.length, start + SNIPPET_MAX_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < cleaned.length ? "…" : "";
  return {
    text: `${prefix}${cleaned.slice(start, end)}${suffix}`,
    matchOffset: prefix.length + cleanedMatch.index - start,
    matchLength: cleanedMatch.length,
  };
}

const WHITESPACE_CHAR_RE = /\s/;

/**
 * Whitespace-collapses `text` the same way `computeItemMatches` always has
 * (`text.replace(/\s+/g, " ").trim()`), while building an offset table that
 * maps any offset in the ORIGINAL text to its corresponding offset in the
 * cleaned text. This is what lets an occurrence located in the original text
 * (the only frame matches are ever found in — see `computeItemMatches`) be
 * placed correctly in the cleaned snippet WITHOUT re-running the query
 * against the cleaned text, which is unsound for whitespace-containing
 * queries (see `makeSnippetFromCleaned`'s doc comment).
 */
function collapseWhitespace(text: string): {
  cleaned: string;
  toCleanedOffset: (originalOffset: number) => number;
} {
  const originalToCleaned: number[] = Array.from({ length: text.length + 1 });
  let cleaned = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (WHITESPACE_CHAR_RE.test(ch)) {
      const runStart = i;
      while (i < text.length && WHITESPACE_CHAR_RE.test(text[i] as string)) i++;
      const isLeading = cleaned.length === 0;
      const isTrailing = i === text.length;
      const collapsedOffset = cleaned.length;
      if (!isLeading && !isTrailing) {
        cleaned += " ";
      }
      for (let k = runStart; k < i; k++) {
        originalToCleaned[k] = collapsedOffset;
      }
    } else {
      originalToCleaned[i] = cleaned.length;
      cleaned += ch;
      i++;
    }
  }
  originalToCleaned[text.length] = cleaned.length;
  return {
    cleaned,
    toCleanedOffset: (originalOffset) => {
      const clamped = Math.max(0, Math.min(originalOffset, text.length));
      return originalToCleaned[clamped] ?? cleaned.length;
    },
  };
}

/**
 * All occurrence-level matches for one item, computed in a single pass: the
 * whitespace-collapsed snippet text and its match positions are computed ONCE
 * per item, not once per occurrence — an item with hundreds of hits used to
 * re-clean and re-scan its full text for every hit, which is exactly the
 * many-hits slowdown on large threads.
 */
interface ComputedItemMatches {
  matches: TimelineSearchMatch[];
  isMatchLimitExceeded: boolean;
}

/** Coarse per-item-kind fallback field, used only when a match's start offset
 * doesn't land inside any known field span (e.g. it falls on the space that
 * joins two fields together). */
function fallbackFieldForItem(item: StreamItem): TimelineSearchField {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "thought":
      return "text";
    case "tool_call":
      return "tool";
    default:
      return "other";
  }
}

/**
 * Finds the field-span containing `offset`. A match is attributed to a field
 * by its START offset only (the simplest well-defined rule for a match that
 * might straddle two fields' text, per `TimelineSearchMatch.fieldOffset`'s
 * doc comment) — this never inspects the match's end offset.
 */
function findSpanForOffset(
  spans: readonly TimelineSearchFieldSpan[],
  offset: number,
): TimelineSearchFieldSpan | undefined {
  return spans.find((span) => offset >= span.start && offset < span.end);
}

function computeItemMatches(
  item: StreamItem,
  text: string,
  spans: readonly TimelineSearchFieldSpan[],
  query: string,
): ComputedItemMatches {
  const occurrences = findAllMatches(text, query, MAX_TIMELINE_SEARCH_MATCHES + 1);
  if (occurrences.length === 0) {
    return { matches: [], isMatchLimitExceeded: false };
  }
  const isMatchLimitExceeded = occurrences.length > MAX_TIMELINE_SEARCH_MATCHES;
  const boundedOccurrences = occurrences.slice(0, MAX_TIMELINE_SEARCH_MATCHES);

  const { cleaned, toCleanedOffset } = collapseWhitespace(text);
  const isShort = cleaned.length <= SNIPPET_MAX_LENGTH;

  return {
    matches: boundedOccurrences.map((occurrence, occurrenceIndex) => {
      const cleanedStart = toCleanedOffset(occurrence.index);
      const cleanedEnd = toCleanedOffset(occurrence.index + occurrence.length);
      const cleanedMatch: TextMatchOccurrence = {
        index: cleanedStart,
        length: Math.max(0, cleanedEnd - cleanedStart),
      };
      const snippet = isShort
        ? { text: cleaned, matchOffset: cleanedMatch.index, matchLength: cleanedMatch.length }
        : makeSnippetFromCleaned(cleaned, cleanedMatch);

      const span = findSpanForOffset(spans, occurrence.index);
      const field = span?.field ?? fallbackFieldForItem(item);
      const fieldOffset = span ? occurrence.index - span.start : occurrence.index;

      return {
        item,
        field,
        fieldOffset,
        snippet: snippet.text,
        snippetMatchOffset: snippet.matchOffset,
        snippetMatchLength: snippet.matchLength,
        matchOffset: occurrence.index,
        matchLength: occurrence.length,
        occurrenceIndex,
      };
    }),
    isMatchLimitExceeded,
  };
}

type ToolCallStreamItem = Extract<StreamItem, { kind: "tool_call" }>;
type ToolCallPayload = ToolCallStreamItem["payload"];
type AgentToolCallData = Extract<ToolCallPayload, { source: "agent" }>["data"];
type OrchestratorToolCallData = Extract<ToolCallPayload, { source: "orchestrator" }>["data"];

function buildAgentToolCallParts(
  data: AgentToolCallData,
  filter: TimelineSearchFilter,
): TimelineSearchFieldPart[] | null {
  const isFailed = data.status === "failed" || data.status === "canceled";
  const isCompleted = data.status === "completed";

  if (filter === "errors") {
    if (!isFailed) return null;
    // For errors: name + input + any error message
    const parts = buildDetailInputParts(data.name, data.detail);
    const err = safeStringify(data.error);
    if (err) parts.push({ field: "toolError", text: err });
    return parts;
  }
  if (filter === "toolCalls") {
    // Input fields only — never output
    return buildDetailInputParts(data.name, data.detail);
  }
  if (filter === "toolOutput") {
    // Output of successfully completed calls only
    if (!isCompleted) return null;
    const output = extractDetailOutput(data.detail);
    return output ? [{ field: "toolOutput", text: output }] : null;
  }
  if (filter === "messages" || filter === "prompts") {
    return null; // tool calls are neither prompts nor messages
  }
  // filter === "all": name + input + output (if completed) + error (if failed)
  const parts = buildDetailInputParts(data.name, data.detail);
  if (isCompleted) {
    const output = extractDetailOutput(data.detail);
    if (output) parts.push({ field: "toolOutput", text: output });
  }
  if (isFailed) {
    const err = safeStringify(data.error);
    if (err) parts.push({ field: "toolError", text: err });
  }
  return parts;
}

function buildOrchestratorToolCallParts(
  data: OrchestratorToolCallData,
  filter: TimelineSearchFilter,
): TimelineSearchFieldPart[] | null {
  const isFailed = data.status === "failed";
  const isCompleted = data.status === "completed";

  if (filter === "errors") {
    if (!isFailed) return null;
    const parts: TimelineSearchFieldPart[] = [{ field: "tool", text: data.toolName }];
    const err = safeStringify(data.error);
    if (err) parts.push({ field: "toolError", text: err });
    return parts;
  }
  if (filter === "toolCalls") {
    const parts: TimelineSearchFieldPart[] = [{ field: "tool", text: data.toolName }];
    const args = safeStringify(data.arguments);
    if (args) parts.push({ field: "toolInput", text: args });
    return parts;
  }
  if (filter === "toolOutput") {
    if (!isCompleted) return null;
    const result = safeStringify(data.result);
    return result ? [{ field: "toolOutput", text: result }] : null;
  }
  if (filter === "messages" || filter === "prompts") {
    return null;
  }
  // all
  const parts: TimelineSearchFieldPart[] = [{ field: "tool", text: data.toolName }];
  const args = safeStringify(data.arguments);
  if (args) parts.push({ field: "toolInput", text: args });
  if (isCompleted) {
    const result = safeStringify(data.result);
    if (result) parts.push({ field: "toolOutput", text: result });
  }
  if (isFailed) {
    const err = safeStringify(data.error);
    if (err) parts.push({ field: "toolError", text: err });
  }
  return parts;
}

function buildToolCallParts(
  item: ToolCallStreamItem,
  filter: TimelineSearchFilter,
): TimelineSearchFieldPart[] | null {
  if (item.payload.source === "agent") {
    return buildAgentToolCallParts(item.payload.data, filter);
  }
  if (item.payload.source === "orchestrator") {
    return buildOrchestratorToolCallParts(item.payload.data, filter);
  }
  return null;
}

/**
 * Joins ordered field parts into one concatenated searchable string (parts
 * are space-separated, matching the original `.filter(Boolean).join(" ")`
 * behavior), recording each surviving part's span boundaries as it goes.
 * Empty-text parts are dropped and contribute no span. Returns null when
 * every part was empty, matching the old `|| null` behavior of the
 * string-only extraction this replaces.
 */
function buildFieldSpans(
  parts: readonly TimelineSearchFieldPart[],
): TimelineSearchExtraction | null {
  const nonEmpty = parts.filter((part) => part.text.length > 0);
  if (nonEmpty.length === 0) return null;
  const spans: TimelineSearchFieldSpan[] = [];
  let text = "";
  for (const part of nonEmpty) {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += part.text;
    spans.push({ field: part.field, start, end: text.length });
  }
  return { text, spans };
}

/**
 * Returns the ordered field parts to match against for a given item + filter
 * combination. Returns null if this item should not be searched under this
 * filter, or an empty array if the filter applies but nothing is present to
 * search (e.g. a todo list whose entries are all blank).
 */
// oxlint-disable-next-line complexity
function buildSearchParts(
  item: StreamItem,
  filter: TimelineSearchFilter,
): TimelineSearchFieldPart[] | null {
  switch (item.kind) {
    case "user_message": {
      // User prompts belong to the "prompts" filter, not "messages".
      if (filter !== "all" && filter !== "prompts") return null;
      const text = item.text;
      return text ? [{ field: "text", text }] : null;
    }

    case "assistant_message": {
      if (filter !== "all" && filter !== "messages") return null;
      const text = item.text;
      return text ? [{ field: "text", text }] : null;
    }

    case "thought": {
      if (filter !== "all" && filter !== "thinking") return null;
      const text = item.text;
      return text ? [{ field: "text", text }] : null;
    }

    case "todo_list": {
      // Each entry is its own field span (`todo:${index}`) so a per-row
      // surface can map a match back onto the specific row it occurred in.
      if (filter !== "all" && filter !== "messages") return null;
      const parts = item.items.map(
        (entry, index): TimelineSearchFieldPart => ({
          field: `todo:${index}` as TimelineSearchField,
          text: entry.text,
        }),
      );
      return parts;
    }

    case "tool_call":
      return buildToolCallParts(item, filter);

    case "activity_log": {
      if (filter !== "all" && filter !== "errors") return null;
      if (filter === "errors" && item.activityType !== "error") return null;
      const message = item.message;
      return message ? [{ field: "text", text: message }] : null;
    }

    case "compaction":
      return null;
  }
}

/**
 * Extracts an item's searchable text for a given filter, WITH per-field span
 * boundaries — the field-span registry that lets a match's offset be mapped
 * back onto the specific rendered field it occurred in (see
 * `TimelineSearchField`/`TimelineSearchMatch.fieldOffset`). Returns null if
 * this item should not be searched under this filter, or has nothing to
 * search.
 */
export function extractSearchSpans(
  item: StreamItem,
  filter: TimelineSearchFilter,
): TimelineSearchExtraction | null {
  const parts = buildSearchParts(item, filter);
  if (!parts) return null;
  return buildFieldSpans(parts);
}

/**
 * Returns text to match against for a given item + filter combination.
 * Returns null if this item should not be searched under this filter. Thin
 * wrapper over `extractSearchSpans` for callers that only need the
 * concatenated text, not the field boundaries.
 */
export function extractSearchText(item: StreamItem, filter: TimelineSearchFilter): string | null {
  return extractSearchSpans(item, filter)?.text ?? null;
}

// ---- Core search ----

/**
 * Hard ceiling on the total number of navigable matches (VS Code-style "999+").
 * Bounds the per-occurrence match array (and the panel's result list) on
 * pathological queries — e.g. a single letter against a fully-paged-in thread —
 * where an unbounded list would burn memory and render time for results nobody
 * will step through. When the cap is hit, the panel shows "999+ matches".
 */
export const MAX_TIMELINE_SEARCH_MATCHES = 999;

/**
 * Per-item memo for `searchItems`, keyed by item object identity (stream items
 * are immutable snapshots — an item is replaced, not mutated, when it changes).
 * Two levels of reuse:
 *  - `text` (the extracted searchable text — for tool calls this includes
 *    JSON.stringify of payloads, the expensive part) is reused whenever the
 *    FILTER is unchanged, even when the query changed (each keystroke);
 *  - `matches` are reused wholesale when both query and filter are unchanged
 *    (each streaming refresh, where only the tail item has a new identity).
 */
interface ItemMatchCacheEntry {
  filter: TimelineSearchFilter;
  text: string | null;
  spans: TimelineSearchFieldSpan[];
  query: string;
  matches: TimelineSearchMatch[];
  isMatchLimitExceeded: boolean;
}
export type TimelineSearchItemCache = WeakMap<StreamItem, ItemMatchCacheEntry>;

export function createTimelineSearchItemCache(): TimelineSearchItemCache {
  return new WeakMap();
}

const EMPTY_ITEM_MATCHES: TimelineSearchMatch[] = [];
const EMPTY_SPANS: TimelineSearchFieldSpan[] = [];

interface TimelineSearchResult {
  matches: TimelineSearchMatch[];
  isMatchLimitExceeded: boolean;
}

function searchItemsWithMetadata(
  items: readonly StreamItem[],
  query: string,
  filter: TimelineSearchFilter,
  cache?: TimelineSearchItemCache,
): TimelineSearchResult {
  const trimmed = query.trim();
  if (!trimmed) return { matches: [], isMatchLimitExceeded: false };

  const results: TimelineSearchMatch[] = [];
  for (const item of items) {
    if (!item) continue;

    const cached = cache?.get(item);
    let itemMatches: TimelineSearchMatch[];
    let itemLimitExceeded: boolean;
    if (cached && cached.filter === filter && cached.query === trimmed) {
      itemMatches = cached.matches;
      itemLimitExceeded = cached.isMatchLimitExceeded;
    } else {
      const extraction =
        cached && cached.filter === filter
          ? { text: cached.text, spans: cached.spans }
          : extractSearchSpans(item, filter);
      const text = extraction?.text ?? null;
      const spans = extraction?.spans ?? EMPTY_SPANS;
      const computed = text
        ? computeItemMatches(item, text, spans, trimmed)
        : { matches: EMPTY_ITEM_MATCHES, isMatchLimitExceeded: false };
      itemMatches = computed.matches;
      itemLimitExceeded = computed.isMatchLimitExceeded;
      cache?.set(item, {
        filter,
        text,
        spans,
        query: trimmed,
        matches: itemMatches,
        isMatchLimitExceeded: itemLimitExceeded,
      });
    }

    const remaining = MAX_TIMELINE_SEARCH_MATCHES - results.length;
    if (itemMatches.length > remaining || (itemMatches.length === remaining && itemLimitExceeded)) {
      results.push(...itemMatches.slice(0, remaining));
      return { matches: results, isMatchLimitExceeded: true };
    }
    results.push(...itemMatches);
  }

  return { matches: results, isMatchLimitExceeded: false };
}

export function searchItems(
  items: readonly StreamItem[],
  query: string,
  filter: TimelineSearchFilter,
  cache?: TimelineSearchItemCache,
): TimelineSearchMatch[] {
  return searchItemsWithMetadata(items, query, filter, cache).matches;
}

// ---- Model factory ----

export interface TimelineSearchModel {
  getState(): TimelineSearchState;
  setQuery(query: string): void;
  setFilter(filter: TimelineSearchFilter): void;
  /**
   * Re-runs the search against the current query/filter and the latest
   * snapshot from `getItems()`. Use this to keep results current while the
   * panel is open and new stream items arrive (setQuery/setFilter only
   * recompute when the query/filter value itself changes).
   */
  refresh(): void;
  selectNext(): void;
  selectPrev(): void;
  selectIndex(index: number): void;
  open(): void;
  close(): void;
  subscribe(listener: () => void): () => void;
}

export function createTimelineSearchModel(
  getItems: () => readonly StreamItem[],
): TimelineSearchModel {
  let state: TimelineSearchState = {
    query: "",
    filter: "all",
    matches: [],
    isMatchLimitExceeded: false,
    selectedIndex: -1,
    isOpen: false,
    navigationRevision: 0,
  };
  const listeners = new Set<() => void>();
  // Per-model item memo: makes streaming refresh() (only the tail item changes
  // identity) and per-keystroke re-searches (text extraction reused) cheap on
  // large, fully-paged-in threads.
  const itemCache = createTimelineSearchItemCache();

  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }

  function recompute(query: string, filter: TimelineSearchFilter) {
    const { matches, isMatchLimitExceeded } = searchItemsWithMetadata(
      getItems(),
      query,
      filter,
      itemCache,
    );
    const selectedIndex = matches.length > 0 ? 0 : -1;
    return { matches, isMatchLimitExceeded, selectedIndex };
  }

  return {
    getState() {
      return state;
    },
    setQuery(query) {
      if (query === state.query) return;
      const { matches, isMatchLimitExceeded, selectedIndex } = recompute(query, state.filter);
      state = { ...state, query, matches, isMatchLimitExceeded, selectedIndex };
      notify();
    },
    setFilter(filter) {
      if (filter === state.filter) return;
      const { matches, isMatchLimitExceeded, selectedIndex } = recompute(state.query, filter);
      state = { ...state, filter, matches, isMatchLimitExceeded, selectedIndex };
      notify();
    },
    refresh() {
      const previousSelectedMatch =
        state.selectedIndex >= 0 ? state.matches[state.selectedIndex] : undefined;
      const previousSelectedKey = previousSelectedMatch
        ? matchKey(previousSelectedMatch)
        : undefined;
      const { matches: newMatches, isMatchLimitExceeded } = searchItemsWithMetadata(
        getItems(),
        state.query,
        state.filter,
        itemCache,
      );
      if (
        state.isMatchLimitExceeded === isMatchLimitExceeded &&
        matchesAreIdEqual(state.matches, newMatches)
      ) {
        // Same occurrences matched, in the same order — keep the existing
        // matches array identity and skip notifying. This is what stops a
        // streaming token from re-triggering the scroll-to-match effect on every
        // refresh() call while the panel is open (see
        // use-timeline-search-scroll.ts, which keys off navigationRevision,
        // not matches identity, for exactly this reason).
        return;
      }
      const preservedIndex = previousSelectedKey
        ? newMatches.findIndex((match) => matchKey(match) === previousSelectedKey)
        : -1;
      const fallbackIndex = newMatches.length > 0 ? 0 : -1;
      const selectedIndex = preservedIndex >= 0 ? preservedIndex : fallbackIndex;
      state = { ...state, matches: newMatches, isMatchLimitExceeded, selectedIndex };
      notify();
    },
    selectNext() {
      if (state.matches.length === 0) return;
      const selectedIndex = (state.selectedIndex + 1) % state.matches.length;
      // Bump navigationRevision even when the computed index equals the
      // current one (a single match) so the scroll effect still re-fires.
      state = { ...state, selectedIndex, navigationRevision: state.navigationRevision + 1 };
      notify();
    },
    selectPrev() {
      if (state.matches.length === 0) return;
      const selectedIndex =
        state.selectedIndex <= 0 ? state.matches.length - 1 : state.selectedIndex - 1;
      state = { ...state, selectedIndex, navigationRevision: state.navigationRevision + 1 };
      notify();
    },
    selectIndex(index) {
      if (index < 0 || index >= state.matches.length) return;
      state = { ...state, selectedIndex: index, navigationRevision: state.navigationRevision + 1 };
      notify();
    },
    open() {
      if (state.isOpen) return;
      const { matches, isMatchLimitExceeded, selectedIndex } = recompute(state.query, state.filter);
      state = {
        ...state,
        isOpen: true,
        matches,
        isMatchLimitExceeded,
        selectedIndex,
        navigationRevision: state.navigationRevision + 1,
      };
      notify();
    },
    close() {
      if (!state.isOpen) return;
      state = { ...state, isOpen: false };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * timeline-search-model.ts
 *
 * Pure, framework-free model for the timeline find panel.
 * Operates entirely on the already-loaded StreamItem[] that is
 * present in the component tree — no server RPCs, no global search.
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
import { findFirstMatch, textMatchesQuery } from "./highlight";

// ---- Filter types ----

export type TimelineSearchFilter =
  | "all"
  | "prompts"
  | "messages"
  | "toolCalls"
  | "toolOutput"
  | "errors";

// ---- Match types ----

export interface TimelineSearchMatch {
  /** The stream item that matched. */
  item: StreamItem;
  /** Snippet for display (truncated to ~80 chars). */
  snippet: string;
}

// ---- Model state ----

export interface TimelineSearchState {
  query: string;
  filter: TimelineSearchFilter;
  matches: TimelineSearchMatch[];
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
 * Extract the INPUT portion of a ToolCallDetail: the name + input arguments.
 * This is what `toolCalls` filter searches.
 */
// oxlint-disable-next-line complexity
function extractDetailInput(name: string, detail: ToolCallDetail): string {
  const parts: string[] = [name];
  switch (detail.type) {
    case "shell":
      parts.push(detail.command);
      if (detail.cwd) parts.push(detail.cwd);
      break;
    case "read":
      parts.push(detail.filePath);
      break;
    case "edit":
      parts.push(detail.filePath);
      if (detail.oldString) parts.push(detail.oldString);
      if (detail.newString) parts.push(detail.newString);
      break;
    case "write":
      parts.push(detail.filePath);
      if (detail.content) parts.push(detail.content);
      break;
    case "search":
      parts.push(detail.query);
      if (detail.filePaths) parts.push(detail.filePaths.join(" "));
      break;
    case "fetch":
      parts.push(detail.url);
      if (detail.prompt) parts.push(detail.prompt);
      break;
    case "sub_agent":
      if (detail.description) parts.push(detail.description);
      break;
    case "plan":
      parts.push(detail.text);
      break;
    case "plain_text":
      if (detail.label) parts.push(detail.label);
      if (detail.text) parts.push(detail.text);
      break;
    case "worktree_setup":
      parts.push(detail.worktreePath, detail.branchName);
      break;
    case "unknown":
      if (detail.input != null) parts.push(safeStringify(detail.input) ?? "");
      break;
  }
  return parts.filter(Boolean).join(" ");
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

/** Whether `a` and `b` contain the same item ids, in the same order. */
function matchesAreIdEqual(
  a: readonly TimelineSearchMatch[],
  b: readonly TimelineSearchMatch[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.item.id !== b[i]?.item.id) return false;
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
 * Builds a display snippet centered on the first match of `query` in `text`,
 * so a deep match is never truncated away before it can be shown. A match
 * that starts within the first `SNIPPET_HEAD_ANCHOR_THRESHOLD` chars keeps
 * the original head-anchored behavior (truncate from the start); a deeper
 * match instead takes a window of `SNIPPET_CONTEXT_BEFORE` chars before the
 * match, filled out to ~`SNIPPET_MAX_LENGTH` chars total, with a leading "…"
 * (and trailing "…" if the window doesn't reach the end of the text).
 */
function makeSnippet(text: string, query: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= SNIPPET_MAX_LENGTH) return cleaned;

  const match = findFirstMatch(cleaned, query);
  if (!match || match.index < SNIPPET_HEAD_ANCHOR_THRESHOLD) {
    return `${cleaned.slice(0, SNIPPET_MAX_LENGTH - 3)}…`;
  }

  const start = Math.max(0, match.index - SNIPPET_CONTEXT_BEFORE);
  const end = Math.min(cleaned.length, start + SNIPPET_MAX_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < cleaned.length ? "…" : "";
  return `${prefix}${cleaned.slice(start, end)}${suffix}`;
}

type ToolCallStreamItem = Extract<StreamItem, { kind: "tool_call" }>;
type ToolCallPayload = ToolCallStreamItem["payload"];
type AgentToolCallData = Extract<ToolCallPayload, { source: "agent" }>["data"];
type OrchestratorToolCallData = Extract<ToolCallPayload, { source: "orchestrator" }>["data"];

function extractAgentToolCallSearchText(
  data: AgentToolCallData,
  filter: TimelineSearchFilter,
): string | null {
  const isFailed = data.status === "failed" || data.status === "canceled";
  const isCompleted = data.status === "completed";

  if (filter === "errors") {
    if (!isFailed) return null;
    // For errors: name + input + any error message
    const base = extractDetailInput(data.name, data.detail);
    const err = safeStringify(data.error);
    return [base, err].filter(Boolean).join(" ") || null;
  }
  if (filter === "toolCalls") {
    // Input fields only — never output
    return extractDetailInput(data.name, data.detail) || null;
  }
  if (filter === "toolOutput") {
    // Output of successfully completed calls only
    if (!isCompleted) return null;
    return extractDetailOutput(data.detail);
  }
  if (filter === "messages" || filter === "prompts") {
    return null; // tool calls are neither prompts nor messages
  }
  // filter === "all": name + input + output (if completed) + error (if failed)
  const input = extractDetailInput(data.name, data.detail);
  const output = isCompleted ? extractDetailOutput(data.detail) : null;
  const error = isFailed ? safeStringify(data.error) : null;
  return [input, output, error].filter(Boolean).join(" ") || null;
}

function extractOrchestratorToolCallSearchText(
  data: OrchestratorToolCallData,
  filter: TimelineSearchFilter,
): string | null {
  const isFailed = data.status === "failed";
  const isCompleted = data.status === "completed";

  if (filter === "errors") {
    if (!isFailed) return null;
    return [data.toolName, safeStringify(data.error)].filter(Boolean).join(" ") || null;
  }
  if (filter === "toolCalls") {
    return [data.toolName, safeStringify(data.arguments)].filter(Boolean).join(" ") || null;
  }
  if (filter === "toolOutput") {
    if (!isCompleted) return null;
    return safeStringify(data.result);
  }
  if (filter === "messages" || filter === "prompts") {
    return null;
  }
  // all
  return (
    [
      data.toolName,
      safeStringify(data.arguments),
      isCompleted ? safeStringify(data.result) : null,
      isFailed ? safeStringify(data.error) : null,
    ]
      .filter(Boolean)
      .join(" ") || null
  );
}

function extractToolCallSearchText(
  item: ToolCallStreamItem,
  filter: TimelineSearchFilter,
): string | null {
  if (item.payload.source === "agent") {
    return extractAgentToolCallSearchText(item.payload.data, filter);
  }
  if (item.payload.source === "orchestrator") {
    return extractOrchestratorToolCallSearchText(item.payload.data, filter);
  }
  return null;
}

/**
 * Returns text to match against for a given item + filter combination.
 * Returns null if this item should not be searched under this filter.
 */
// oxlint-disable-next-line complexity
export function extractSearchText(item: StreamItem, filter: TimelineSearchFilter): string | null {
  switch (item.kind) {
    case "user_message": {
      // User prompts belong to the "prompts" filter, not "messages".
      if (filter !== "all" && filter !== "prompts") return null;
      return item.text || null;
    }

    case "assistant_message":
    case "thought": {
      if (filter !== "all" && filter !== "messages") return null;
      return item.text || null;
    }

    case "todo_list": {
      if (filter !== "all" && filter !== "messages") return null;
      const text = item.items.map((e) => e.text).join(" ");
      return text || null;
    }

    case "tool_call":
      return extractToolCallSearchText(item, filter);

    case "activity_log": {
      if (filter !== "all" && filter !== "errors") return null;
      if (filter === "errors" && item.activityType !== "error") return null;
      return item.message || null;
    }

    case "compaction":
      return null;
  }
}

// ---- Core search ----

export function searchItems(
  items: readonly StreamItem[],
  query: string,
  filter: TimelineSearchFilter,
): TimelineSearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const results: TimelineSearchMatch[] = [];
  for (const item of items) {
    if (!item) continue;
    const text = extractSearchText(item, filter);
    if (!text) continue;
    if (!textMatchesQuery(text, trimmed)) continue;
    results.push({ item, snippet: makeSnippet(text, trimmed) });
  }
  return results;
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
    selectedIndex: -1,
    isOpen: false,
    navigationRevision: 0,
  };
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }

  function recompute(query: string, filter: TimelineSearchFilter) {
    const matches = searchItems(getItems(), query, filter);
    const selectedIndex = matches.length > 0 ? 0 : -1;
    return { matches, selectedIndex };
  }

  return {
    getState() {
      return state;
    },
    setQuery(query) {
      if (query === state.query) return;
      const { matches, selectedIndex } = recompute(query, state.filter);
      state = { ...state, query, matches, selectedIndex };
      notify();
    },
    setFilter(filter) {
      if (filter === state.filter) return;
      const { matches, selectedIndex } = recompute(state.query, filter);
      state = { ...state, filter, matches, selectedIndex };
      notify();
    },
    refresh() {
      const previousSelectedId =
        state.selectedIndex >= 0 ? state.matches[state.selectedIndex]?.item.id : undefined;
      const newMatches = searchItems(getItems(), state.query, state.filter);
      if (matchesAreIdEqual(state.matches, newMatches)) {
        // Same items matched, in the same order — keep the existing matches
        // array identity and skip notifying. This is what stops a streaming
        // token from re-triggering the scroll-to-match effect on every
        // refresh() call while the panel is open (see
        // use-timeline-search-scroll.ts, which keys off navigationRevision,
        // not matches identity, for exactly this reason).
        return;
      }
      const preservedIndex = previousSelectedId
        ? newMatches.findIndex((match) => match.item.id === previousSelectedId)
        : -1;
      const fallbackIndex = newMatches.length > 0 ? 0 : -1;
      const selectedIndex = preservedIndex >= 0 ? preservedIndex : fallbackIndex;
      state = { ...state, matches: newMatches, selectedIndex };
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
      const { matches, selectedIndex } = recompute(state.query, state.filter);
      state = {
        ...state,
        isOpen: true,
        matches,
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

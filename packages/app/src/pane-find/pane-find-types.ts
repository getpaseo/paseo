/**
 * pane-find-types.ts
 *
 * Shared contract between a workspace pane (agent/chat, and future
 * terminal/file/browser panes) and the pane-find registry. A pane that wants
 * `workspace.find.open` (Ctrl/Cmd+F) to reach it registers one of these.
 *
 * Adapters own their own search/match logic (e.g. the timeline search
 * model's filters). The registry only tracks *which* pane is focused and
 * routes open/close/query/next/prev commands to that pane's adapter.
 */

export interface PaneFindState {
  isOpen: boolean;
  query: string;
  /** True while an async search for the current query is in flight. */
  isPending: boolean;
  matchCount: number;
  /** Zero-based index into the adapter's own match list; -1 when none selected. */
  selectedIndex: number;
}

export interface PaneFindAdapter {
  /**
   * True when the pane renders its own find UI (e.g. the rich filtered
   * timeline search panel) instead of the shared `PaneFindBar`. The shared
   * bar is skipped for these panes.
   */
  hasCustomUI: boolean;
  getState(): PaneFindState;
  subscribe(listener: () => void): () => void;
  open(): void;
  close(): void;
  /** Receives a trimmed non-empty query, or "" to clear the find state. */
  setQuery(query: string): void;
  selectNext(): void;
  selectPrev(): void;
}

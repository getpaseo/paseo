import {
  EMPTY_HISTORY_STATE,
  pushEntry,
  replaceEntryAt,
  type HistoryEntry,
  type HistoryState,
} from "./model";

/**
 * In-memory history of visited locations, scoped to this app session like a browser window's
 * back/forward list. A closure store rather than zustand so the keyboard executor can read and
 * step it synchronously; same shape as the last-workspace selection store.
 */
export function createNavigationHistoryStore() {
  let state: HistoryState = EMPTY_HISTORY_STATE;
  const listeners = new Set<() => void>();

  function setState(next: HistoryState) {
    if (next === state) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    record: (entry: HistoryEntry) => setState(pushEntry(state, entry)),
    setIndex: (index: number) => {
      if (index < 0 || index >= state.entries.length || index === state.index) {
        return;
      }
      setState({ entries: state.entries, index });
    },
    replaceCurrent: (entry: HistoryEntry) => setState(replaceEntryAt(state, state.index, entry)),
    reset: () => setState(EMPTY_HISTORY_STATE),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type NavigationHistoryStore = ReturnType<typeof createNavigationHistoryStore>;

export const navigationHistoryStore = createNavigationHistoryStore();

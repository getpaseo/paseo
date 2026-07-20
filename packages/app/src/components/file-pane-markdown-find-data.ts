import type { PaneFindAdapter, PaneFindState } from "@/pane-find/pane-find-types";
import { findAllMatches } from "@/timeline-search/highlight";

export interface MarkdownFindTextRun {
  key: string;
  content: string;
}

export function countMarkdownFindMatches(content: string, query: string): number {
  return findAllMatches(content, query).length;
}

/**
 * Assign each rendered Markdown text run the ordinal of its first find match.
 * The ordinal is deliberately shared with the source find model so the selected
 * result gets the active style while the preview remains rendered Markdown.
 */
export function createMarkdownFindMatchBases(input: {
  query: string;
  runs: readonly MarkdownFindTextRun[];
}): ReadonlyMap<string, number> {
  const matchBases = new Map<string, number>();
  let nextMatchIndex = 0;

  for (const run of input.runs) {
    if (matchBases.has(run.key)) continue;
    matchBases.set(run.key, nextMatchIndex);
    nextMatchIndex += countMarkdownFindMatches(run.content, input.query);
  }

  return matchBases;
}

export interface MarkdownFindModel {
  adapter: PaneFindAdapter;
}

function countFindMatchesInRuns(runs: readonly MarkdownFindTextRun[], query: string): number {
  const seenKeys = new Set<string>();
  let matchCount = 0;

  for (const run of runs) {
    if (seenKeys.has(run.key)) {
      continue;
    }
    seenKeys.add(run.key);
    matchCount += countMarkdownFindMatches(run.content, query);
  }

  return matchCount;
}

export function createMarkdownFindModel(input: {
  getRuns: () => readonly MarkdownFindTextRun[];
  onSelectMatch: (matchIndex: number) => void;
}): MarkdownFindModel {
  const listeners = new Set<() => void>();
  let state: PaneFindState = {
    isOpen: false,
    query: "",
    isPending: false,
    matchCount: 0,
    selectedIndex: -1,
  };

  function emit(nextState: PaneFindState): void {
    state = nextState;
    for (const listener of listeners) {
      listener();
    }
  }

  function select(index: number): void {
    if (state.matchCount === 0) {
      return;
    }
    const selectedIndex = (index + state.matchCount) % state.matchCount;
    emit({ ...state, selectedIndex });
    input.onSelectMatch(selectedIndex);
  }

  return {
    adapter: {
      hasCustomUI: false,
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      open() {
        emit({ ...state, isOpen: true });
      },
      close() {
        emit({ isOpen: false, query: "", isPending: false, matchCount: 0, selectedIndex: -1 });
      },
      setQuery(query) {
        const matchCount = countFindMatchesInRuns(input.getRuns(), query);
        const selectedIndex = matchCount > 0 ? 0 : -1;
        emit({ ...state, query, matchCount, selectedIndex });
        if (selectedIndex >= 0) {
          select(selectedIndex);
        }
      },
      selectNext() {
        select(state.selectedIndex + 1);
      },
      selectPrev() {
        select(state.selectedIndex - 1);
      },
    },
  };
}

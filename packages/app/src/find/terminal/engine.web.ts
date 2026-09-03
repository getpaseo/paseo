import type { TerminalEmulatorHandle } from "@/components/terminal-emulator-contract";
import type { FindEngine, FindResult } from "@/find/engine";
import { EMPTY_FIND_RESULT } from "@/find/model";
import type { TerminalFindResults } from "@/terminal/runtime/terminal-emulator-runtime";

export interface TerminalFindEngine extends FindEngine {
  /** Results reported by @xterm/addon-search, including its own rescans after output. */
  reportResults: (results: TerminalFindResults) => void;
  /** The terminal swapped buffers and dropped the search; run the query again. */
  reapply: () => void;
}

export interface TerminalFindEngineInput {
  getEmulator: () => TerminalEmulatorHandle | null;
}

/**
 * How long a typed query has to stand still before the terminal is searched.
 *
 * The other engines search a bounded corpus — the open document, the assistant render
 * cap — and run per keystroke. The terminal's is not bounded: scrollback is settable up
 * to a million lines, the addon walks every row when a term has few or no matches, and
 * its line cache is thrown away on every line feed, so a terminal that is producing
 * output makes each scan a cold one. That is a full pass on the same main thread that
 * renders the output, per character typed.
 */
const QUERY_SETTLE_MS = 120;

/**
 * Find over xterm.js.
 *
 * The search addon owns the match list, the selection and the decorations, so this
 * engine only forwards commands and republishes what the addon reports back. Counts
 * therefore arrive asynchronously — the addon also rescans 200ms after terminal output —
 * which is why nothing here computes a count of its own.
 */
export function createTerminalFindEngine({
  getEmulator,
}: TerminalFindEngineInput): TerminalFindEngine {
  const listeners = new Set<(result: FindResult) => void>();
  let result: FindResult = EMPTY_FIND_RESULT;
  let query = "";
  let pendingSearch: ReturnType<typeof setTimeout> | null = null;

  function emit(next: FindResult): void {
    result = next;
    for (const listener of listeners) {
      listener(next);
    }
  }

  function cancelPendingSearch(): void {
    if (pendingSearch === null) {
      return;
    }
    clearTimeout(pendingSearch);
    pendingSearch = null;
  }

  function scheduleSearch(delayMs: number): void {
    cancelPendingSearch();
    pendingSearch = setTimeout(() => {
      pendingSearch = null;
      getEmulator()?.findNext(query);
    }, delayMs);
  }

  return {
    setQuery(nextQuery) {
      query = nextQuery;
      if (nextQuery === "") {
        cancelPendingSearch();
        getEmulator()?.clearFind();
        emit(EMPTY_FIND_RESULT);
        return;
      }
      scheduleSearch(QUERY_SETTLE_MS);
    },
    next() {
      if (query === "") {
        return;
      }
      // Enter flushes the wait rather than queueing behind it: the step the user asked
      // for has to happen now, and a pending search would only repeat this one.
      cancelPendingSearch();
      getEmulator()?.findNext(query);
    },
    previous() {
      if (query === "") {
        return;
      }
      cancelPendingSearch();
      getEmulator()?.findPrevious(query);
    },
    clear() {
      query = "";
      cancelPendingSearch();
      getEmulator()?.clearFind();
      emit(EMPTY_FIND_RESULT);
    },
    subscribe(listener) {
      listener(result);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      cancelPendingSearch();
      // A retained pane can be deactivated with the bar open; its decorations would
      // otherwise survive on a terminal nobody is searching any more.
      getEmulator()?.clearFind();
    },
    reportResults({ resultIndex, resultCount, countIsCapped }) {
      const activeIndex = resultIndex >= 0 ? resultIndex : null;
      if (countIsCapped) {
        // Past the addon's highlight limit it stops tracking matches, so it cannot say
        // where the active one sits and reports -1 forever.
        emit({ count: resultCount, activeIndex, countIsCapped: true });
        return;
      }
      emit({ count: resultCount, activeIndex });
    },
    reapply() {
      if (query === "") {
        return;
      }
      // The buffer swap is reported while the escape sequence that caused it is still
      // being parsed. Decorations anchor to the cursor row, so searching before the
      // terminal settles would pin them to a position that is about to move.
      scheduleSearch(0);
    },
  };
}

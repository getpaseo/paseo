import { useEffect, useRef, useState } from "react";

export interface TimelineSearchHistoryPagingInput {
  /** Whether the find panel is open. */
  isOpen: boolean;
  /** The current search query (paging only runs for a non-empty query). */
  query: string;
  /** Whether the timeline has older persisted history not yet loaded. */
  hasOlder: boolean;
  /** Whether an older-history fetch is already in flight. */
  isLoadingOlder: boolean;
  /**
   * Number of items currently loaded into the timeline. Used to detect
   * no-progress fetches: a completed load that neither grew the item list nor
   * cleared `hasOlder` counts as a failed attempt.
   */
  itemCount: number;
  /** Loads the next older page of history into the timeline. */
  loadOlder: () => void | Promise<void>;
}

export interface TimelineSearchHistoryPagingResult {
  /**
   * True while older history is still being paged in for the active query —
   * the panel shows a "searching history" pending state instead of a premature
   * "no results" while the full timeline is still loading.
   */
  isPaging: boolean;
  /**
   * True when paging gave up because consecutive loads made no progress
   * (e.g. the daemon is unreachable). The panel shows an "older history could
   * not be loaded" note so partial results aren't mistaken for complete ones.
   */
  historyLoadFailed: boolean;
}

/**
 * Consecutive completed-but-fruitless loads (no new items, `hasOlder` still
 * true) tolerated before giving up. `loadOlder` already toasts per failure, so
 * without a stop the open panel would retry — and toast — forever.
 */
const MAX_FRUITLESS_LOADS = 3;

/**
 * Drives complete-history timeline search. The pure search model can only match
 * items already loaded into the timeline; while the find panel is open with a
 * non-empty query, this pages older persisted history in until none remains, so
 * search covers the whole conversation rather than only the currently
 * mounted/virtualized window.
 *
 * The loop is self-driving: the effect fires one page, and when it lands
 * `hasOlder`/`isLoadingOlder` change and re-run the effect for the next page,
 * until `hasOlder` is false. Clearing the query or closing the panel stops it
 * (any in-flight page just lands in the store cache harmlessly). `loadOlder`
 * itself re-checks the in-flight/has-older guards, so an extra call is a no-op.
 *
 * Failure stop: a load that completes without growing the item list (and
 * without clearing `hasOlder`) counts as fruitless — e.g. the fetch failed and
 * was swallowed upstream. After `MAX_FRUITLESS_LOADS` consecutive fruitless
 * loads the loop stops and reports `historyLoadFailed` instead of retrying
 * (and re-toasting) forever. Changing the query re-arms the loop.
 */
export function useTimelineSearchHistoryPaging({
  isOpen,
  query,
  hasOlder,
  isLoadingOlder,
  itemCount,
  loadOlder,
}: TimelineSearchHistoryPagingInput): TimelineSearchHistoryPagingResult {
  const trimmedQuery = query.trim();
  const active = isOpen && trimmedQuery.length > 0;

  const [stalled, setStalled] = useState(false);
  const fruitlessLoadsRef = useRef(0);
  const inFlightStartCountRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  // A new query (or a reopened panel) re-arms a stalled loop.
  useEffect(() => {
    generationRef.current += 1;
    fruitlessLoadsRef.current = 0;
    inFlightStartCountRef.current = null;
    setStalled(false);
  }, [trimmedQuery, isOpen]);

  // Track load completions and whether they made progress.
  useEffect(() => {
    if (isLoadingOlder) return;
    if (inFlightStartCountRef.current === null) {
      return;
    }
    const grew = itemCount > inFlightStartCountRef.current;
    inFlightStartCountRef.current = null;
    if (grew || !hasOlder) {
      fruitlessLoadsRef.current = 0;
      return;
    }
    fruitlessLoadsRef.current += 1;
    if (fruitlessLoadsRef.current >= MAX_FRUITLESS_LOADS) {
      setStalled(true);
    }
  }, [isLoadingOlder, itemCount, hasOlder]);

  useEffect(() => {
    if (!active || !hasOlder || isLoadingOlder || stalled) {
      return;
    }
    const generation = generationRef.current;
    inFlightStartCountRef.current = itemCount;
    try {
      void Promise.resolve(loadOlder()).catch(() => {
        if (generation === generationRef.current) setStalled(true);
      });
    } catch {
      if (generation === generationRef.current) setStalled(true);
    }
  }, [active, hasOlder, isLoadingOlder, itemCount, stalled, loadOlder]);

  return {
    isPaging: active && hasOlder && !stalled,
    historyLoadFailed: active && stalled,
  };
}

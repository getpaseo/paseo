import { useEffect } from "react";

export interface TimelineSearchHistoryPagingInput {
  /** Whether the find panel is open. */
  isOpen: boolean;
  /** The current search query (paging only runs for a non-empty query). */
  query: string;
  /** Whether the timeline has older persisted history not yet loaded. */
  hasOlder: boolean;
  /** Whether an older-history fetch is already in flight. */
  isLoadingOlder: boolean;
  /** Loads the next older page of history into the timeline. */
  loadOlder: () => void | Promise<void>;
}

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
 * Returns whether paging is still in progress, so the panel can show a
 * "searching history" pending state instead of a premature "no results" while
 * the full timeline is still loading.
 */
export function useTimelineSearchHistoryPaging({
  isOpen,
  query,
  hasOlder,
  isLoadingOlder,
  loadOlder,
}: TimelineSearchHistoryPagingInput): boolean {
  const active = isOpen && query.trim().length > 0;

  useEffect(() => {
    if (!active || !hasOlder || isLoadingOlder) {
      return;
    }
    void loadOlder();
  }, [active, hasOlder, isLoadingOlder, loadOlder]);

  return active && hasOlder;
}

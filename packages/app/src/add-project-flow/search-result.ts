/**
 * What a search shows while the user types. `items` keep the last results until the current
 * query's results arrive, so rows do not flash away on every keystroke.
 */
export interface SearchResult<T> {
  items: T[];
  /** Results for the current query have not arrived yet. */
  pending: boolean;
  error: string | null;
}

/** One answer from the host: what it found for `query`, or why it could not search. */
export interface SearchAnswer<T> {
  hostId: string | null;
  query: string;
  items: T[];
  error: string | null;
}

/**
 * Decides what to show for `query` on `hostId`. An answer from another host never shows. While
 * the current query is pending the last items stay, but an old error does not.
 */
export function resolveSearch<T>(input: {
  enabled: boolean;
  hostId: string | null;
  /** What the user typed. */
  query: string;
  /** The query the last request was sent for; it trails `query` while the user types. */
  debouncedQuery: string;
  /** The latest answer, which may be for an earlier query or another host. */
  data: SearchAnswer<T> | undefined;
  /** Why the request for `debouncedQuery` failed, if it did. */
  failed: string | null;
  empty: T[];
}): SearchResult<T> {
  const { enabled, hostId, query, debouncedQuery, data, failed, empty } = input;
  if (!enabled) return { items: empty, pending: false, error: null };
  if (failed) {
    return query === debouncedQuery
      ? { items: empty, pending: false, error: failed }
      : { items: empty, pending: true, error: null };
  }
  const answer = data?.hostId === hostId ? data : undefined;
  if (answer?.query === query) return { items: answer.items, pending: false, error: answer.error };
  return { items: answer && !answer.error ? answer.items : empty, pending: true, error: null };
}

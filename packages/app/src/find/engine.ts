/**
 * What a find surface has to be able to do, independent of how its text is stored.
 *
 * Three implementations exist because the three searchable surfaces keep their text
 * in three places nothing can unify: the transcript's loaded stream items, xterm's
 * buffer, and CodeMirror's document. The find bar drives all of them through this.
 */
export interface FindResult {
  /** Total matches; 0 when the query is empty. */
  count: number;
  /** 0-based position of the active match, or null when there is none. */
  activeIndex: number | null;
  /**
   * The engine stopped counting at a limit of its own, so `count` is a floor. Absent
   * means the count is exact. xterm's search addon is the one that hits this: it tracks
   * only the matches it highlighted, and reports no position for anything past them.
   */
  countIsCapped?: boolean;
}

export interface FindEngine {
  /**
   * Re-run the search: highlight every match and activate the first one at or after
   * the current viewport position, wrapping to the first. An empty query clears.
   */
  setQuery(query: string): void;
  next(): void;
  previous(): void;
  /** Drop the highlights and any selection the engine made, then emit an empty result. */
  clear(): void;
  /** Emits the current result immediately, then after every change. */
  subscribe(listener: (result: FindResult) => void): () => void;
  dispose(): void;
}

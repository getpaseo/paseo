import type { FindResult } from "@/find/engine";

export const EMPTY_FIND_RESULT: FindResult = { count: 0, activeIndex: null };

export interface FindStepInput {
  activeIndex: number | null;
  count: number;
  delta: 1 | -1;
}

/**
 * The next active match in a travel direction, wrapping at both ends.
 *
 * With no active match yet, stepping forward lands on the first and stepping back
 * lands on the last, so Cmd+G and Cmd+Shift+G both do something useful the moment a
 * query produces results.
 */
export function stepActiveIndex({ activeIndex, count, delta }: FindStepInput): number | null {
  if (count === 0) {
    return null;
  }
  if (activeIndex === null) {
    return delta === 1 ? 0 : count - 1;
  }
  return (activeIndex + delta + count) % count;
}

/**
 * Keeps an active pointer inside a match list that just changed size, which happens
 * whenever the surface's content changes under an open find bar.
 */
export function clampActiveIndex(activeIndex: number | null, count: number): number | null {
  if (count === 0 || activeIndex === null) {
    return null;
  }
  return Math.min(Math.max(activeIndex, 0), count - 1);
}

import { createContext, useContext, useMemo } from "react";

/**
 * The stream item currently targeted by timeline-search navigation.
 *
 * Provided as a context (next to the highlight-query provider) rather than
 * props because history rows are memoized by revision objects — a prop would
 * never reach a row that has no other reason to re-render, while a context
 * consumer re-renders on value change regardless of ancestor memoization.
 *
 * Consumers that bring the target into view (todo cards auto-expanding, tool
 * call groups scrolling their inner viewport) should key their effects off
 * `navigationRevision`, which mirrors the search model's counter: it bumps on
 * every explicit navigation, including re-selecting the same item, so Enter on
 * a single match still re-fires the effect.
 */
export interface TimelineSearchTarget {
  itemId: string;
  /** The source field that produced this match, when it maps to a rendered text surface. */
  field: "text" | "tool" | "other";
  /** Offset/length within the source field; used to distinguish one occurrence from another. */
  matchOffset: number;
  matchLength: number;
  navigationRevision: number;
}

const TimelineSearchTargetContext = createContext<TimelineSearchTarget | null>(null);

export const TimelineSearchTargetProvider = TimelineSearchTargetContext.Provider;

export function useTimelineSearchTarget(): TimelineSearchTarget | null {
  return useContext(TimelineSearchTargetContext);
}

/**
 * Derives the provider value from the search model state with a stable
 * identity: the returned object only changes when the selected item or the
 * navigation revision changes — never on unrelated state notifications
 * (keystrokes, streaming refreshes), which would otherwise re-render every
 * context consumer in the thread.
 */
export function useTimelineSearchTargetValue(state: {
  isOpen: boolean;
  selectedIndex: number;
  navigationRevision: number;
  matches: readonly {
    item: { id: string };
    field: TimelineSearchTarget["field"];
    matchOffset: number;
    matchLength: number;
  }[];
}): TimelineSearchTarget | null {
  const match = state.isOpen ? (state.matches[state.selectedIndex] ?? null) : null;
  const itemId = match?.item.id ?? null;
  const field = match?.field ?? "other";
  const matchOffset = match?.matchOffset ?? 0;
  const matchLength = match?.matchLength ?? 0;
  const { navigationRevision } = state;
  return useMemo(
    () =>
      itemId
        ? {
            itemId,
            field,
            matchOffset,
            matchLength,
            navigationRevision,
          }
        : null,
    [itemId, field, matchOffset, matchLength, navigationRevision],
  );
}

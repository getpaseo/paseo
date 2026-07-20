import { createContext, useContext, useMemo } from "react";
import type { TimelineSearchField } from "./timeline-search-model";

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
  /**
   * The specific field-span that produced this match (e.g. "text", "tool",
   * "toolInput", "toolOutput", "toolError", or a per-entry `todo:N`) — see
   * `TimelineSearchField` in timeline-search-model.ts. This is what a
   * renderer that owns a single field's own text should compare against
   * before trusting `fieldOffset`.
   */
  field: TimelineSearchField;
  /**
   * Offset/length of this occurrence within its OWN field's text (i.e.
   * relative to the start of the field-span, not the concatenated
   * cross-field searchable string). This is the offset a renderer should
   * slice against when it only has that one field's raw text on hand.
   */
  fieldOffset: number;
  /**
   * Offset within the item's full concatenated searchable text (all fields
   * joined). Kept for occurrence identity/back-compat — NOT meaningful as an
   * index into any single rendered field's text; use `fieldOffset` for that.
   */
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
    fieldOffset: number;
    matchOffset: number;
    matchLength: number;
  }[];
}): TimelineSearchTarget | null {
  const match = state.isOpen ? (state.matches[state.selectedIndex] ?? null) : null;
  const itemId = match?.item.id ?? null;
  const field = match?.field ?? "other";
  const fieldOffset = match?.fieldOffset ?? 0;
  const matchOffset = match?.matchOffset ?? 0;
  const matchLength = match?.matchLength ?? 0;
  const { navigationRevision } = state;
  return useMemo(
    () =>
      itemId
        ? {
            itemId,
            field,
            fieldOffset,
            matchOffset,
            matchLength,
            navigationRevision,
          }
        : null,
    [itemId, field, fieldOffset, matchOffset, matchLength, navigationRevision],
  );
}

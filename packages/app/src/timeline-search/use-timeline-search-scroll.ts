import { useEffect, useRef, useState, type RefObject } from "react";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { resolveTimelineSearchScrollTarget } from "./resolve-scroll-target";
import type { TimelineSearchMatch } from "./timeline-search-model";

export interface UseTimelineSearchScrollInput {
  isOpen: boolean;
  matches: readonly TimelineSearchMatch[];
  selectedIndex: number;
  /**
   * Bumped by the model on every explicit navigation (open/selectNext/
   * selectPrev/selectIndex) — including when the resulting index doesn't
   * change. The scroll effect below keys off this (plus the selected
   * item's id), not `matches` identity, so a streaming refresh() that
   * rebuilds `matches` without changing the selection never re-triggers a
   * scroll.
   */
  navigationRevision: number;
  isLiveHeadItem: (itemId: string) => boolean;
  findGroupIdForItem: (itemId: string) => string | null;
  isGroupExpanded: (groupId: string) => boolean;
  expandGroup: (groupId: string) => void;
  viewportRef: RefObject<StreamViewportHandle | null>;
  /** Injectable for tests; defaults to the real rAF pair. */
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * Scrolls the active timeline to the currently selected search match.
 * Returns the navigationRevision this hook has actually finished issuing a
 * coarse scroll for (`null` before the first one) — the occurrence-anchor
 * fine-correction stage in agent-stream/view.tsx gates on this so a
 * text-level correction never races ahead of the row/group scroll it's
 * relative to.
 *
 * A collapsed tool-call group must be expanded before its host row can be
 * measured and scrolled to. Expanding is a state update, so this effect
 * intentionally returns without settling right after requesting it — the
 * caller's `isGroupExpanded` result (re-derived below on every render, not
 * gated behind the callback's own identity) flips once the expansion has
 * committed, which re-fires the effect for the second pass that performs the
 * actual scroll on the next frame (giving the newly expanded content a
 * chance to be laid out).
 */
export function useTimelineSearchScroll(input: UseTimelineSearchScrollInput): number | null {
  const {
    isOpen,
    matches,
    selectedIndex,
    navigationRevision,
    isLiveHeadItem,
    findGroupIdForItem,
    isGroupExpanded,
    expandGroup,
    viewportRef,
    requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
  } = input;

  const selectedItemId = matches[selectedIndex]?.item.id;

  // `expandGroup` triggers a side effect (a state update in the caller) and
  // must only ever be invoked from inside the effect below, never during
  // render — read the latest one through a ref rather than adding it to the
  // effect's dependency array, where its identity churning on every ~48ms
  // stream flush would re-fire the effect and re-issue scrollToItem
  // constantly (the scroll-hijack bug this hook exists to avoid).
  const expandGroupRef = useRef(expandGroup);
  expandGroupRef.current = expandGroup;

  // `isLiveHeadItem`/`findGroupIdForItem`/`isGroupExpanded` are pure lookups
  // with no side effects, so — unlike `expandGroup` — they're safe to call
  // directly during render. Doing so derives the scroll target and the
  // target group's expansion state down to plain primitives (kind/groupId/
  // itemId/boolean) that only change value when the *outcome* of the lookup
  // actually changes, decoupling the effect below from the callbacks' own
  // identity churn (recreated on every stream flush and every unrelated
  // group toggle in the caller, view.tsx) while still reacting to a real
  // expansion-state flip.
  const resolvedTarget =
    isOpen && selectedItemId
      ? resolveTimelineSearchScrollTarget({
          itemId: selectedItemId,
          isLiveHeadItem,
          findGroupIdForItem,
        })
      : null;
  const targetKind = resolvedTarget?.kind ?? null;
  const targetGroupId = resolvedTarget?.kind === "group" ? resolvedTarget.groupId : null;
  const isTargetGroupExpanded = targetGroupId ? isGroupExpanded(targetGroupId) : false;

  // The navigationRevision this hook has actually finished a coarse scroll
  // for. `null` until the first scrollToItem/scrollToBottom is issued.
  const [settledRevision, setSettledRevision] = useState<number | null>(null);
  // A second result within the same message or expanded tool-call group only
  // needs the occurrence-anchor correction. Re-centering the containing row
  // first produces a visible flash (row centre -> exact match) even when both
  // results are already in the viewport.
  const lastCoarseTargetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      lastCoarseTargetKeyRef.current = null;
      return;
    }
    if (!selectedItemId || !resolvedTarget) {
      return;
    }

    let coarseTargetKey: string;
    if (resolvedTarget.kind === "group") {
      coarseTargetKey = `group:${resolvedTarget.groupId}`;
    } else if (resolvedTarget.kind === "bottom") {
      coarseTargetKey = `bottom:${selectedItemId}`;
    } else {
      coarseTargetKey = `item:${resolvedTarget.itemId}`;
    }

    if (lastCoarseTargetKeyRef.current === coarseTargetKey) {
      setSettledRevision(navigationRevision);
      return;
    }

    if (resolvedTarget.kind === "bottom") {
      viewportRef.current?.scrollToBottom("jump-to-bottom");
      lastCoarseTargetKeyRef.current = coarseTargetKey;
      setSettledRevision(navigationRevision);
      return;
    }

    if (resolvedTarget.kind === "group" && !isTargetGroupExpanded) {
      expandGroupRef.current(resolvedTarget.groupId);
      return;
    }

    const scrollTargetId =
      resolvedTarget.kind === "group" ? resolvedTarget.groupId : resolvedTarget.itemId;
    const frame = requestFrame(() => {
      const didScroll = viewportRef.current?.scrollToItem(scrollTargetId);
      if (didScroll === false) {
        // Native can't scrollToIndex into a row that only exists in the
        // still-streaming live head (it isn't part of the virtualized
        // FlatList `data` yet, unlike web's DOM-wide querySelector fallback)
        // — the nearest reachable target for an unreachable row is the
        // bottom of the stream.
        viewportRef.current?.scrollToBottom("jump-to-bottom");
      }
      lastCoarseTargetKeyRef.current = coarseTargetKey;
      setSettledRevision(navigationRevision);
    });
    return () => cancelFrame(frame);
    // Deliberately NOT depending on the raw isLiveHeadItem/findGroupIdForItem/
    // isGroupExpanded callbacks or `matches` — those churn on every ~48ms
    // stream flush and tool-call-group toggle in the caller (view.tsx),
    // which previously re-fired this effect and re-issued scrollToItem on
    // every flush (the scroll-hijack bug). `resolvedTarget`'s kind/groupId
    // and `isTargetGroupExpanded` are derived to plain values during render
    // above, so the effect only re-runs when the *outcome* of those lookups
    // actually changes (open/navigation/selection/target-kind/expansion),
    // never on a closure identity change alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    navigationRevision,
    selectedItemId,
    targetKind,
    targetGroupId,
    isTargetGroupExpanded,
    viewportRef,
    requestFrame,
    cancelFrame,
  ]);

  return settledRevision;
}

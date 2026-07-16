import { useEffect, type RefObject } from "react";
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
 *
 * A collapsed tool-call group must be expanded before its host row can be
 * measured and scrolled to. Expanding is a state update, so this effect
 * intentionally returns without scrolling right after requesting it —
 * `isGroupExpanded`/`expandGroup` are dependencies, so the effect re-runs
 * once the expansion has committed, and the second pass performs the actual
 * scroll on the next frame (giving the newly expanded content a chance to
 * be laid out).
 */
export function useTimelineSearchScroll(input: UseTimelineSearchScrollInput): void {
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

  useEffect(() => {
    if (!isOpen || !selectedItemId) {
      return;
    }

    const target = resolveTimelineSearchScrollTarget({
      itemId: selectedItemId,
      isLiveHeadItem,
      findGroupIdForItem,
    });

    if (target.kind === "bottom") {
      viewportRef.current?.scrollToBottom("jump-to-bottom");
      return;
    }

    if (target.kind === "group" && !isGroupExpanded(target.groupId)) {
      expandGroup(target.groupId);
      return;
    }

    const scrollTargetId = target.kind === "group" ? target.groupId : target.itemId;
    const frame = requestFrame(() => {
      viewportRef.current?.scrollToItem(scrollTargetId);
    });
    return () => cancelFrame(frame);
    // Deliberately NOT depending on `matches` — only on navigationRevision
    // and the resolved selected item id. `matches` is rebuilt on every
    // refresh() while streaming; re-running this effect on that alone is
    // exactly the scroll-hijack bug this hook exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    navigationRevision,
    selectedItemId,
    isLiveHeadItem,
    findGroupIdForItem,
    isGroupExpanded,
    expandGroup,
    viewportRef,
    requestFrame,
    cancelFrame,
  ]);
}

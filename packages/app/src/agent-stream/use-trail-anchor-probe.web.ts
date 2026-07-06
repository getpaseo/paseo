import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { TrailAnchorStore } from "./message-trail-anchor";
import { computeTrailAnchor } from "./message-trail-probe";
import {
  getElementTopWithinScrollContainer,
  isScrollContainerAtBottom,
  prefersReducedMotion,
  scrollContainerToElementTopOffset,
  type ScrollBehaviorLike,
  syncNearBottom,
} from "./web-scroll-geometry";

export interface UseTrailAnchorProbeInput {
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  rowVirtualizer: Virtualizer<HTMLElement, Element>;
  historyVirtualized: readonly { id: string }[];
  historyMounted: readonly unknown[];
  liveHead: readonly unknown[];
  virtualTotalSize: number;
  trailItemIds: readonly string[] | undefined;
  trailAnchor: TrailAnchorStore | undefined;
  cancelPendingStickToBottom: () => void;
  setFollowOutput: (value: boolean) => boolean;
  onNearBottomChange: (value: boolean) => void;
}

export interface UseTrailAnchorProbeResult {
  scheduleTrailAnchorProbe: () => void;
  scrollToMessage: (itemId: string) => void;
  handleVirtualRowsContainerRef: (node: HTMLElement | null) => void;
  onScrollAreaResized: () => void;
}

export function useTrailAnchorProbe(input: UseTrailAnchorProbeInput): UseTrailAnchorProbeResult {
  const {
    scrollContainerRef,
    rowVirtualizer,
    historyVirtualized,
    historyMounted,
    liveHead,
    virtualTotalSize,
    trailItemIds,
    trailAnchor,
    cancelPendingStickToBottom,
    setFollowOutput,
    onNearBottomChange,
  } = input;

  const virtualRowsContainerRef = useRef<HTMLElement | null>(null);
  const handleVirtualRowsContainerRef = useCallback((node: HTMLElement | null) => {
    virtualRowsContainerRef.current = node;
  }, []);

  // Message-trail anchor probe state. One pending rAF at a time; offsets cached per id
  // and invalidated on virtual total-size changes and container resizes.
  const trailProbeFrameRef = useRef<number | null>(null);
  const trailOffsetCacheRef = useRef<Map<string, number>>(new Map());

  // Keep the latest trail inputs in refs so the scroll probe callback identity is stable
  // (the scroll listener effect keys off handleDomScroll; we don't want to rebind it when
  // the trail id set changes on every flush).
  const trailItemIdsRef = useRef<readonly string[] | undefined>(trailItemIds);
  trailItemIdsRef.current = trailItemIds;
  const trailAnchorRef = useRef<typeof trailAnchor>(trailAnchor);
  trailAnchorRef.current = trailAnchor;

  // Resolve a trail id's top offset within the scroll container's content coordinate space.
  // Prefers the mounted DOM row (cheap, exact); falls back to the virtualizer's cached
  // measurement (plus the virtual container's own offset) for virtualized-away rows.
  const resolveTrailOffset = useCallback(
    (scrollContainer: HTMLElement, id: string): number | null => {
      const cache = trailOffsetCacheRef.current;
      const cached = cache.get(id);
      if (cached !== undefined) {
        return cached;
      }
      const mounted = document.getElementById(`stream-item-${id}`);
      if (mounted instanceof HTMLElement && scrollContainer.contains(mounted)) {
        const offset = getElementTopWithinScrollContainer(scrollContainer, mounted);
        cache.set(id, offset);
        return offset;
      }
      const virtualizedIndex = historyVirtualized.findIndex((item) => item.id === id);
      if (virtualizedIndex >= 0) {
        const measurement = rowVirtualizer.measurementsCache[virtualizedIndex];
        const virtualContainer = virtualRowsContainerRef.current;
        if (measurement && virtualContainer) {
          const containerTop = getElementTopWithinScrollContainer(
            scrollContainer,
            virtualContainer,
          );
          const offset = containerTop + measurement.start;
          cache.set(id, offset);
          return offset;
        }
      }
      return null;
    },
    [rowVirtualizer, historyVirtualized],
  );

  const runTrailAnchorProbe = useCallback(() => {
    const anchor = trailAnchorRef.current;
    const ids = trailItemIdsRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!anchor || !ids || ids.length === 0 || !scrollContainer) {
      return;
    }
    anchor.publish(
      computeTrailAnchor({
        ids,
        scrollTop: scrollContainer.scrollTop,
        clientHeight: scrollContainer.clientHeight,
        isAtBottom: isScrollContainerAtBottom(scrollContainer),
        resolveOffset: (id) => resolveTrailOffset(scrollContainer, id),
      }),
    );
  }, [resolveTrailOffset, scrollContainerRef]);

  const scheduleTrailAnchorProbe = useCallback(() => {
    if (!trailAnchorRef.current || trailProbeFrameRef.current !== null) {
      return;
    }
    trailProbeFrameRef.current = window.requestAnimationFrame(() => {
      trailProbeFrameRef.current = null;
      runTrailAnchorProbe();
    });
  }, [runTrailAnchorProbe]);

  // Cached trail offsets go stale when virtualized rows re-measure (shifting content
  // offsets) or when the mounted/virtualized/live segments change. Drop the cache and
  // re-probe so the anchor reflects the new geometry.
  useEffect(() => {
    trailOffsetCacheRef.current.clear();
    scheduleTrailAnchorProbe();
  }, [historyMounted, historyVirtualized, liveHead, virtualTotalSize, scheduleTrailAnchorProbe]);

  useEffect(() => {
    return () => {
      if (trailProbeFrameRef.current !== null) {
        window.cancelAnimationFrame(trailProbeFrameRef.current);
        trailProbeFrameRef.current = null;
      }
    };
  }, []);

  const onScrollAreaResized = useCallback(() => {
    trailOffsetCacheRef.current.clear();
    scheduleTrailAnchorProbe();
  }, [scheduleTrailAnchorProbe]);

  const scrollToMessage = useCallback(
    (itemId: string) => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      // Stop the follow-output machine from yanking scroll back to the bottom while
      // (and after) we reposition to the requested row.
      cancelPendingStickToBottom();
      setFollowOutput(false);

      const behavior: ScrollBehaviorLike = prefersReducedMotion() ? "auto" : "smooth";
      const elementId = `stream-item-${itemId}`;

      const mountedElement = document.getElementById(elementId);
      if (mountedElement instanceof HTMLElement && scrollContainer.contains(mountedElement)) {
        scrollContainerToElementTopOffset(scrollContainer, mountedElement, behavior);
        syncNearBottom(scrollContainer, onNearBottomChange);
        return;
      }

      // The row may live inside virtualized (unmounted) history. Scroll its index into
      // view, then re-locate the now-mounted element after layout settles and fine-tune.
      const virtualizedIndex = historyVirtualized.findIndex((item) => item.id === itemId);
      if (virtualizedIndex < 0) {
        // Not addressable and not in virtualized history: id isn't in the stream. No-op.
        return;
      }

      rowVirtualizer.scrollToIndex(virtualizedIndex, { align: "start" });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const container = scrollContainerRef.current;
          if (!container) {
            return;
          }
          const element = document.getElementById(elementId);
          if (element instanceof HTMLElement && container.contains(element)) {
            scrollContainerToElementTopOffset(container, element, behavior);
          }
          syncNearBottom(container, onNearBottomChange);
        });
      });
    },
    [
      cancelPendingStickToBottom,
      setFollowOutput,
      onNearBottomChange,
      rowVirtualizer,
      historyVirtualized,
      scrollContainerRef,
    ],
  );

  return {
    scheduleTrailAnchorProbe,
    scrollToMessage,
    handleVirtualRowsContainerRef,
    onScrollAreaResized,
  };
}

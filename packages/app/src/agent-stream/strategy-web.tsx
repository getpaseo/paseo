import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";
import { withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { Theme } from "@/styles/theme";
import { WEB_SCROLLBAR_SIZE_PX } from "@/styles/web-scrollbar";
import { estimateStreamItemHeight } from "./web-virtualization";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import { createStreamStrategy } from "./strategy";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationTransition,
} from "./history-start-pagination";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";
import { useScrollToMessage } from "./use-scroll-to-message.web";

interface CreateWebStreamStrategyInput {
  isMobileBreakpoint: boolean;
}

interface HistoryStartPrependAnchor {
  progressKey: string;
  rowId: string;
  viewportOffset: number;
}

type ScrollBehaviorLike = "auto" | "smooth";

const WEB_BOTTOM_SETTLE_TIMEOUT_MS = 200;
const USER_SCROLL_DELTA_EPSILON = 1;
const BOTTOM_OVERSCROLL_TOLERANCE_PX = 2;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1;
const HISTORY_START_SETTLE_FRAMES = 2;
const HISTORY_START_SLOT_HEIGHT_PX = 32;
const CONTENT_PADDING_TOP_PX = 16;
const UPWARD_INPUT_EVIDENCE_TIMEOUT_MS = 100;
const VIRTUALIZER_SCROLL_MARGIN_PX = HISTORY_START_SLOT_HEIGHT_PX + CONTENT_PADDING_TOP_PX;
// A row has to clear this much of the viewport top before the next one takes over as the
// reading position, so a row resting exactly on the edge does not flip back and forth.
const READING_POSITION_OFFSET_PX = 8;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function findHistoryRowElement(contentNode: HTMLElement, rowId: string): HTMLElement | null {
  for (const element of contentNode.querySelectorAll<HTMLElement>("[data-history-row-id]")) {
    if (element.dataset.historyRowId === rowId) {
      return element;
    }
  }
  return null;
}

const historyStartSlotStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: HISTORY_START_SLOT_HEIGHT_PX,
  flexShrink: 0,
};

const streamRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
};

function isScrollContainerNearBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  const { scrollTop, clientHeight, scrollHeight } = scrollContainer;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}

function isScrollContainerAtBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): boolean {
  return isScrollContainerNearBottom(scrollContainer, AUTO_SCROLL_RESUME_THRESHOLD_PX);
}

function isScrollContainerMeasurable(
  scrollContainer: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): boolean {
  return scrollContainer.clientHeight > 0 && scrollContainer.scrollHeight > 0;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const editableRoot = target.closest("input, textarea, [contenteditable]");
  if (!editableRoot) {
    return false;
  }
  const tagName = editableRoot.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea") {
    return true;
  }
  return editableRoot.getAttribute("contenteditable")?.toLowerCase() !== "false";
}

function isUpwardViewportScrollKey(event: KeyboardEvent): boolean {
  if (isEditableEventTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

function canNestedScrollerConsumeUpwardInput(
  target: EventTarget | null,
  scrollContainer: HTMLElement,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== scrollContainer) {
    if (element instanceof HTMLElement) {
      const overflowY = window.getComputedStyle(element).overflowY;
      const canScroll = overflowY === "auto" || overflowY === "scroll";
      if (canScroll && element.scrollHeight > element.clientHeight && element.scrollTop > 0) {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

function isVerticalScrollbarGutterPress(
  event: PointerEvent,
  scrollContainer: HTMLElement,
): boolean {
  if (event.target !== scrollContainer) {
    return false;
  }
  if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
    return false;
  }
  const scrollbarWidth = Math.max(
    scrollContainer.offsetWidth - scrollContainer.clientWidth,
    WEB_SCROLLBAR_SIZE_PX,
  );
  const bounds = scrollContainer.getBoundingClientRect();
  return window.getComputedStyle(scrollContainer).direction === "rtl"
    ? event.clientX <= bounds.left + scrollbarWidth
    : event.clientX >= bounds.right - scrollbarWidth;
}

function scrollElementToBottom(
  scrollContainer: HTMLElement,
  behavior: ScrollBehaviorLike = "auto",
): void {
  scrollContainer.scrollTo({
    top: scrollContainer.scrollHeight,
    behavior,
  });
}

function syncNearBottom(
  scrollContainer: HTMLElement | null,
  onNearBottomChange: (value: boolean) => void,
): boolean {
  if (!scrollContainer) {
    onNearBottomChange(true);
    return true;
  }
  const nextValue = isScrollContainerNearBottom(scrollContainer);
  onNearBottomChange(nextValue);
  return nextValue;
}

function getScrollContainerDistanceFromBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): number {
  return scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
}

function isScrollContainerOverscrolledPastBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): boolean {
  return getScrollContainerDistanceFromBottom(scrollContainer) < -BOTTOM_OVERSCROLL_TOLERANCE_PX;
}

function WebStreamViewport(props: StreamRenderInput & { isMobileBreakpoint: boolean }) {
  const {
    segments,
    liveHeadRowRevision,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    onReadingPositionChange,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    olderHistoryProgressKey,
    scrollEnabled,
    isMobileBreakpoint,
  } = props;
  const isActive = useRetainedPanelActive();
  const isActiveRef = useRef(isActive);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const handleScrollContainerRef = useCallback((node: HTMLElement | null) => {
    scrollContainerRef.current = node;
  }, []);
  const handleContentRef = useCallback((node: HTMLElement | null) => {
    contentRef.current = node;
  }, []);
  const [followOutput, setFollowOutputr] = useState(true);
  const followOutputRef = useRef(followOutput);
  const setFollowOutput = (value: boolean) => {
    followOutputRef.current = value;
    setFollowOutputr(value);
    return value;
  };
  const lastKnownScrollTopRef = useRef(0);
  const mouseScrollGestureRef = useRef<
    | { kind: "scrollbar"; pointerId: number }
    | {
        kind: "autoscroll";
        pointerId: number;
        lastClientY: number;
        hasUpwardEvidence: boolean;
        evidenceExpiryFrame: number | null;
      }
    | null
  >(null);
  const upwardInputEvidenceUntilRef = useRef(0);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingAutoScrollTimeoutRef = useRef<number | null>(null);
  const pendingVirtualRowMeasureFramesRef = useRef(new Map<Element, number>());
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartPrependAnchorRef = useRef<HistoryStartPrependAnchor | null>(null);
  const historyStartPrependAnchorActiveRef = useRef(false);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);
  const shouldUseVirtualizer = segments.historyVirtualized.length > 0;
  const {
    renderHistoryVirtualizedRow,
    renderHistoryMountedRow,
    renderLiveHeadRow,
    renderLiveAuxiliary,
  } = renderers;

  isActiveRef.current = isActive;
  followOutputRef.current = followOutput;

  const hasRouteBottomAnchorRequest = routeBottomAnchorRequest !== null;
  const activationKey = routeBottomAnchorRequest?.requestKey ?? props.agentId;
  const isActivationReady = !hasRouteBottomAnchorRequest || isAuthoritativeHistoryReady;

  const rowVirtualizer = useVirtualizer({
    count: segments.historyVirtualized.length,
    enabled: shouldUseVirtualizer,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index: number) => segments.historyVirtualized[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = segments.historyVirtualized[index];
      return row ? estimateStreamItemHeight(row) : 120;
    },
    measureElement: measureVirtualElement,
    scrollMargin: VIRTUALIZER_SCROLL_MARGIN_PX,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      if (historyStartPrependAnchorActiveRef.current) {
        return false;
      }
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput | null => {
    const scrollContainer = scrollContainerRef.current;
    if (!isActiveRef.current || !scrollContainer || !isScrollContainerMeasurable(scrollContainer)) {
      return null;
    }
    const bottomAnchorSettled =
      !followOutputRef.current || isScrollContainerNearBottom(scrollContainer);
    return {
      distanceFromHistoryStart: scrollContainer.scrollTop,
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady: historyStartReadyRef.current && bottomAnchorSettled,
      progressKey: olderHistoryProgressKey,
    };
  });
  const applyHistoryStartPaginationTransition = useStableEvent(
    (transition: HistoryStartPaginationTransition) => {
      const previousState = historyStartPaginationStateRef.current;
      historyStartPaginationStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setHistoryStartPaginationState(transition.state);
      }
      if (!isHistoryStartLoadingOperation(transition.state)) {
        historyStartPrependAnchorRef.current = null;
        historyStartPrependAnchorActiveRef.current = false;
      }
      if (!transition.shouldLoad || olderHistoryProgressKey === null) {
        return;
      }
      const scrollContainer = scrollContainerRef.current;
      const contentNode = contentRef.current;
      const anchorRow = segments.historyMounted.at(-1) ?? segments.historyVirtualized.at(-1);
      const anchorElement =
        contentNode && anchorRow ? findHistoryRowElement(contentNode, anchorRow.id) : null;
      if (scrollContainer && anchorRow && anchorElement) {
        historyStartPrependAnchorRef.current = {
          progressKey: olderHistoryProgressKey,
          rowId: anchorRow.id,
          viewportOffset:
            anchorElement.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
        };
      } else {
        historyStartPrependAnchorRef.current = null;
      }
      historyStartPrependAnchorActiveRef.current = false;
      const requestedProgressKey = olderHistoryProgressKey;
      void (async () => {
        const started = await onNearHistoryStart();
        if (started === true) {
          return;
        }
        applyHistoryStartPaginationTransition({
          state: abandonHistoryStartPaginationRequest(
            historyStartPaginationStateRef.current,
            requestedProgressKey,
          ),
          shouldLoad: false,
        });
      })();
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const input = getHistoryStartPaginationInput();
    if (!input) {
      return;
    }
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      input,
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const rearmHistoryStartFromUserIntent = useStableEvent(() => {
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed === historyStartPaginationStateRef.current) {
      return;
    }
    historyStartPaginationStateRef.current = rearmed;
    setHistoryStartPaginationState(rearmed);
    evaluateHistoryStart();
  });
  const applyHistoryStartPrependAnchor = useStableEvent(() => {
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    const anchor = historyStartPrependAnchorRef.current;
    if (
      !scrollContainer ||
      !contentNode ||
      !anchor ||
      !historyStartPrependAnchorActiveRef.current
    ) {
      return;
    }
    const anchorElement = findHistoryRowElement(contentNode, anchor.rowId);
    if (!anchorElement) {
      return;
    }
    const viewportOffset =
      anchorElement.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
    scrollContainer.scrollTop += viewportOffset - anchor.viewportOffset;
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
  });
  const scheduleHistoryStartPrependSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (frame) => window.cancelAnimationFrame(frame),
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => {
          const input = getHistoryStartPaginationInput();
          return (
            !input ||
            input.isLoadingOlderHistory ||
            pendingVirtualRowMeasureFramesRef.current.size > 0
          );
        },
        onFrame: applyHistoryStartPrependAnchor,
        onSettle: () => {
          const input = getHistoryStartPaginationInput();
          if (!input) {
            return;
          }
          historyStartPrependAnchorActiveRef.current = false;
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            input,
          );
          historyStartPrependAnchorRef.current = null;
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  useLayoutEffect(() => {
    if (!isActiveRef.current) {
      return;
    }
    const anchor = historyStartPrependAnchorRef.current;
    if (!anchor || anchor.progressKey === olderHistoryProgressKey) {
      return;
    }
    historyStartPrependAnchorActiveRef.current = true;
    evaluateHistoryStart();
    applyHistoryStartPrependAnchor();
    scheduleHistoryStartPrependSettle();
  }, [
    applyHistoryStartPrependAnchor,
    evaluateHistoryStart,
    olderHistoryProgressKey,
    scheduleHistoryStartPrependSettle,
    segments.historyMounted,
    segments.historyVirtualized,
    virtualTotalSize,
  ]);

  const measureVirtualizedRowElement = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        rowVirtualizer.measureElement(null);
        return;
      }
      const pendingFrames = pendingVirtualRowMeasureFramesRef.current;
      const existingFrame = pendingFrames.get(node);
      if (existingFrame !== undefined) {
        window.cancelAnimationFrame(existingFrame);
      }
      const frame = window.requestAnimationFrame(() => {
        pendingFrames.delete(node);
        if (isActiveRef.current && node.isConnected) {
          rowVirtualizer.measureElement(node);
        }
      });
      pendingFrames.set(node, frame);
    },
    [rowVirtualizer],
  );

  useEffect(() => {
    const pendingFrames = pendingVirtualRowMeasureFramesRef.current;
    return () => {
      for (const frame of pendingFrames.values()) {
        window.cancelAnimationFrame(frame);
      }
      pendingFrames.clear();
    };
  }, []);

  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame !== null) {
      pendingAutoScrollFrameRef.current = null;
      window.cancelAnimationFrame(pendingFrame);
    }
    const pendingTimeout = pendingAutoScrollTimeoutRef.current;
    if (pendingTimeout !== null) {
      pendingAutoScrollTimeoutRef.current = null;
      window.clearTimeout(pendingTimeout);
    }
  }, []);

  const clearMouseScrollGesture = useCallback(() => {
    const gesture = mouseScrollGestureRef.current;
    const evidenceExpiryFrame = gesture?.kind === "autoscroll" ? gesture.evidenceExpiryFrame : null;
    if (evidenceExpiryFrame !== null && evidenceExpiryFrame !== undefined) {
      window.cancelAnimationFrame(evidenceExpiryFrame);
    }
    mouseScrollGestureRef.current = null;
  }, []);

  const clearUpwardInputEvidence = useCallback(() => {
    upwardInputEvidenceUntilRef.current = 0;
  }, []);

  const markUpwardInputEvidence = useCallback(() => {
    upwardInputEvidenceUntilRef.current =
      window.performance.now() + UPWARD_INPUT_EVIDENCE_TIMEOUT_MS;
  }, []);

  useLayoutEffect(() => {
    if (isActive) {
      return;
    }
    cancelPendingStickToBottom();
    historyStartSettleSchedulerRef.current?.cancel();
    for (const frame of pendingVirtualRowMeasureFramesRef.current.values()) {
      window.cancelAnimationFrame(frame);
    }
    pendingVirtualRowMeasureFramesRef.current.clear();
    clearMouseScrollGesture();
    clearUpwardInputEvidence();
    lastTouchClientYRef.current = null;
  }, [cancelPendingStickToBottom, clearMouseScrollGesture, clearUpwardInputEvidence, isActive]);

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehaviorLike = "auto") => {
      const scrollContainer = scrollContainerRef.current;
      if (
        !isActiveRef.current ||
        !scrollContainer ||
        !isScrollContainerMeasurable(scrollContainer)
      ) {
        return;
      }
      if (isScrollContainerOverscrolledPastBottom(scrollContainer)) {
        return;
      }
      scrollElementToBottom(scrollContainer, behavior);
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      syncNearBottom(scrollContainer, onNearBottomChange);
      evaluateHistoryStart();
    },
    [evaluateHistoryStart, onNearBottomChange],
  );

  const scheduleStickToBottom = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer && isScrollContainerOverscrolledPastBottom(scrollContainer)) {
      return;
    }
    if (pendingAutoScrollFrameRef.current !== null) {
      return;
    }
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      if (!isActiveRef.current || !followOutputRef.current) {
        return;
      }
      scrollMessagesToBottom("auto");
    });
  }, [scrollMessagesToBottom]);

  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom("auto");
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);

  // Rows are laid out in DOM order, virtualized block first, so the first row whose bottom
  // clears the reading line is the one the reader is looking at.
  const reportReadingPosition = useStableEvent(() => {
    if (!isActiveRef.current) {
      return;
    }
    if (!onReadingPositionChange) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollContainer || !contentNode) {
      onReadingPositionChange(null);
      return;
    }
    const readingLine = scrollContainer.getBoundingClientRect().top + READING_POSITION_OFFSET_PX;
    let readingRowId: string | null = null;
    for (const element of contentNode.querySelectorAll<HTMLElement>("[data-history-row-id]")) {
      const rowId = element.dataset.historyRowId;
      if (!rowId) {
        continue;
      }
      readingRowId = rowId;
      if (element.getBoundingClientRect().bottom > readingLine) {
        break;
      }
    }
    onReadingPositionChange(readingRowId);
  });

  const updateScrollMetrics = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      onNearBottomChange(true);
      return;
    }
    syncNearBottom(scrollContainer, onNearBottomChange);
    reportReadingPosition();
  }, [onNearBottomChange, reportReadingPosition]);

  const { isJumpSettling, scrollToMessage } = useScrollToMessage({
    active: isActive,
    scrollContainerRef,
    rowVirtualizer,
    historyVirtualized: segments.historyVirtualized,
    cancelPendingStickToBottom,
    setFollowOutput,
    onNearBottomChange,
  });

  const stopFollowingOutputFromUserIntent = useStableEvent(() => {
    cancelPendingStickToBottom();
    if (followOutputRef.current) {
      setFollowOutput(false);
    }
    rearmHistoryStartFromUserIntent();
  });

  const handleDomScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!isActiveRef.current || !scrollContainer || !isScrollContainerMeasurable(scrollContainer)) {
      return;
    }

    const currentScrollTop = scrollContainer.scrollTop;
    const isAtBottom = isScrollContainerAtBottom(scrollContainer);
    const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - USER_SCROLL_DELTA_EPSILON;
    const scrolledDown =
      currentScrollTop > lastKnownScrollTopRef.current + USER_SCROLL_DELTA_EPSILON;
    const mouseGesture = mouseScrollGestureRef.current;
    const hasUpwardInputEvidence =
      mouseGesture?.kind === "scrollbar" ||
      (mouseGesture?.kind === "autoscroll" && mouseGesture.hasUpwardEvidence) ||
      window.performance.now() < upwardInputEvidenceUntilRef.current;

    if (!followOutputRef.current && isAtBottom && scrolledDown && !isJumpSettling()) {
      setFollowOutput(true);
    } else if (followOutputRef.current && scrolledUp && hasUpwardInputEvidence) {
      stopFollowingOutputFromUserIntent();
    }

    lastKnownScrollTopRef.current = currentScrollTop;
    updateScrollMetrics();
    evaluateHistoryStart();
  }, [
    evaluateHistoryStart,
    isJumpSettling,
    stopFollowingOutputFromUserIntent,
    updateScrollMetrics,
  ]);

  useEffect(() => {
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    historyStartPrependAnchorRef.current = null;
    historyStartPrependAnchorActiveRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      historyStartReadyRef.current = false;
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [evaluateHistoryStart, props.agentId]);

  useLayoutEffect(() => {
    if (!isActiveRef.current || !isActivationReady) {
      return;
    }
    if (hasRouteBottomAnchorRequest && !followOutputRef.current) {
      return;
    }
    setFollowOutput(true);
    forceStickToBottom();
    const timeout = window.setTimeout(() => {
      if (!followOutputRef.current) {
        return;
      }
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      if (isScrollContainerNearBottom(scrollContainer)) {
        return;
      }
      scheduleStickToBottom();
    }, WEB_BOTTOM_SETTLE_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    activationKey,
    forceStickToBottom,
    hasRouteBottomAnchorRequest,
    isActivationReady,
    scheduleStickToBottom,
  ]);

  // Following output is a layout invariant: rows, footer, and bottom offset must
  // reach the browser in the same paint.
  useLayoutEffect(() => {
    if (!isActive || !followOutputRef.current) {
      return;
    }
    cancelPendingStickToBottom();
    scrollMessagesToBottom("auto");
  }, [
    cancelPendingStickToBottom,
    isActive,
    renderLiveAuxiliary,
    scrollMessagesToBottom,
    segments.historyMounted,
    segments.historyVirtualized,
    segments.liveHead,
    virtualTotalSize,
  ]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    updateScrollMetrics();
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartPrependSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isActive,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartPrependSettle,
    segments.historyMounted.length,
    segments.historyVirtualized.length,
    segments.liveHead.length,
    updateScrollMetrics,
    virtualTotalSize,
  ]);

  useLayoutEffect(() => {
    if (!isActive) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }

    updateScrollMetrics();
    evaluateHistoryStart();
    const observer = new ResizeObserver(() => {
      if (historyStartPrependAnchorActiveRef.current) {
        applyHistoryStartPrependAnchor();
      }
      if (historyStartPaginationStateRef.current.status === "settling") {
        scheduleHistoryStartPrependSettle();
      }
      updateScrollMetrics();
      evaluateHistoryStart();
      if (!followOutputRef.current) {
        return;
      }
      scheduleStickToBottom();
    });
    observer.observe(scrollContainer);
    if (contentNode) {
      observer.observe(contentNode);
    }
    return () => {
      observer.disconnect();
    };
  }, [
    applyHistoryStartPrependAnchor,
    evaluateHistoryStart,
    isActive,
    scheduleHistoryStartPrependSettle,
    scheduleStickToBottom,
    updateScrollMetrics,
  ]);

  useLayoutEffect(() => {
    if (!isActive) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const markUpwardViewportInput = () => {
      markUpwardInputEvidence();
      if (scrollContainer.scrollTop <= USER_SCROLL_DELTA_EPSILON) {
        rearmHistoryStartFromUserIntent();
      }
    };
    const handleWheel = (event: WheelEvent) => {
      if (
        !event.ctrlKey &&
        event.deltaY < 0 &&
        !canNestedScrollerConsumeUpwardInput(event.target, scrollContainer)
      ) {
        markUpwardViewportInput();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isUpwardViewportScrollKey(event)) {
        return;
      }
      if (canNestedScrollerConsumeUpwardInput(event.target, scrollContainer)) {
        return;
      }
      markUpwardViewportInput();
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearMouseScrollGesture();
      if (
        event.pointerType !== "mouse" ||
        !event.isPrimary ||
        (event.button !== 0 && event.button !== 1) ||
        isEditableEventTarget(event.target)
      ) {
        return;
      }
      if (event.button === 0) {
        if (isVerticalScrollbarGutterPress(event, scrollContainer)) {
          mouseScrollGestureRef.current = { kind: "scrollbar", pointerId: event.pointerId };
        }
        return;
      }
      mouseScrollGestureRef.current = {
        kind: "autoscroll",
        pointerId: event.pointerId,
        lastClientY: event.clientY,
        hasUpwardEvidence: false,
        evidenceExpiryFrame: null,
      };
    };
    const handlePointerMove = (event: PointerEvent) => {
      const gesture = mouseScrollGestureRef.current;
      if (!gesture || gesture.kind !== "autoscroll" || gesture.pointerId !== event.pointerId) {
        return;
      }
      if (event.clientY < gesture.lastClientY - USER_SCROLL_DELTA_EPSILON) {
        gesture.hasUpwardEvidence = true;
        if (gesture.evidenceExpiryFrame !== null) {
          window.cancelAnimationFrame(gesture.evidenceExpiryFrame);
        }
        gesture.evidenceExpiryFrame = window.requestAnimationFrame(() => {
          if (mouseScrollGestureRef.current === gesture) {
            mouseScrollGestureRef.current = null;
          }
        });
      }
      gesture.lastClientY = event.clientY;
    };
    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = mouseScrollGestureRef.current;
      if (gesture?.pointerId === event.pointerId && gesture.kind === "scrollbar") {
        clearMouseScrollGesture();
      }
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (mouseScrollGestureRef.current?.pointerId === event.pointerId) {
        clearMouseScrollGesture();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      lastTouchClientYRef.current = touch.clientY;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      const previousTouchY = lastTouchClientYRef.current;
      if (
        previousTouchY !== null &&
        touch.clientY > previousTouchY + 1 &&
        !canNestedScrollerConsumeUpwardInput(event.target, scrollContainer)
      ) {
        markUpwardViewportInput();
      }
      lastTouchClientYRef.current = touch.clientY;
    };
    const handleTouchEnd = () => {
      lastTouchClientYRef.current = null;
    };

    scrollContainer.addEventListener("scroll", handleDomScroll, { passive: true });
    scrollContainer.addEventListener("wheel", handleWheel, { passive: true });
    scrollContainer.addEventListener("keydown", handleKeyDown, { passive: true });
    scrollContainer.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerup", handlePointerEnd, { passive: true });
    window.addEventListener("pointercancel", handlePointerCancel, { passive: true });
    window.addEventListener("blur", clearMouseScrollGesture);
    scrollContainer.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollContainer.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollContainer.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollContainer.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      scrollContainer.removeEventListener("scroll", handleDomScroll);
      scrollContainer.removeEventListener("wheel", handleWheel);
      scrollContainer.removeEventListener("keydown", handleKeyDown);
      scrollContainer.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", clearMouseScrollGesture);
      scrollContainer.removeEventListener("touchstart", handleTouchStart);
      scrollContainer.removeEventListener("touchmove", handleTouchMove);
      scrollContainer.removeEventListener("touchend", handleTouchEnd);
      scrollContainer.removeEventListener("touchcancel", handleTouchEnd);
      clearUpwardInputEvidence();
    };
  }, [
    clearMouseScrollGesture,
    clearUpwardInputEvidence,
    handleDomScroll,
    isActive,
    markUpwardInputEvidence,
    rearmHistoryStartFromUserIntent,
  ]);

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: () => {
        setFollowOutput(true);
        cancelPendingStickToBottom();
        forceStickToBottom();
      },
      prepareForViewportChange: () => {
        if (!followOutputRef.current) {
          return;
        }
        scheduleStickToBottom();
      },
      scrollToItem: scrollToMessage,
      scrollToMessage,
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
      cancelPendingStickToBottom();
    };
  }, [
    cancelPendingStickToBottom,
    forceStickToBottom,
    scheduleStickToBottom,
    scrollToMessage,
    viewportRef,
  ]);

  const contentContainerStyle = useMemo((): CSSProperties => {
    return {
      display: "flex",
      flexDirection: "column",
      minHeight: "100%",
      paddingTop: CONTENT_PADDING_TOP_PX,
      paddingBottom: 16,
      paddingLeft: isMobileBreakpoint ? 8 : 16,
      paddingRight: isMobileBreakpoint ? 8 : 16,
      boxSizing: "border-box",
    };
  }, [isMobileBreakpoint]);
  const scrollContainerStyle = useMemo((): CSSProperties => {
    return {
      flex: 1,
      minHeight: 0,
      overflowX: "hidden",
      overflowY: scrollEnabled ? "auto" : "hidden",
      overscrollBehaviorY: "contain",
    };
  }, [scrollEnabled]);
  const virtualRowsContainerStyle = useMemo((): CSSProperties => {
    return {
      position: "relative",
      width: "100%",
      height: virtualTotalSize,
    };
  }, [virtualTotalSize]);
  const renderVirtualRowStyle = useCallback(
    (start: number): CSSProperties => ({
      position: "absolute",
      top: 0,
      left: 0,
      display: "flex",
      flexDirection: "column",
      width: "100%",
      transform: `translateY(${start - VIRTUALIZER_SCROLL_MARGIN_PX}px)`,
    }),
    [],
  );
  const mountedHistoryRows = useMemo(() => {
    return segments.historyMounted.map((item, index) => (
      <div key={item.id} data-history-row-id={item.id} style={streamRowStyle}>
        {renderHistoryMountedRow(item, index, segments.historyMounted)}
      </div>
    ));
  }, [renderHistoryMountedRow, segments.historyMounted]);
  const liveHeadRows = useMemo(() => {
    void liveHeadRowRevision;
    return segments.liveHead.map((item, index) => (
      <div key={item.id} data-history-row-id={item.id} style={streamRowStyle}>
        {renderLiveHeadRow(item, index, segments.liveHead)}
      </div>
    ));
  }, [liveHeadRowRevision, renderLiveHeadRow, segments.liveHead]);
  const liveAuxiliary = useMemo(() => {
    return renderLiveAuxiliary();
  }, [renderLiveAuxiliary]);
  const historyStartSlot = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    return (
      <div style={historyStartSlotStyle} data-testid="older-history-slot">
        {isLoadingOperation ? (
          <div data-testid="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </div>
        ) : null}
      </div>
    );
  }, [historyStartPaginationState]);
  const shouldRenderEmpty =
    !boundary.hasMountedHistory &&
    !boundary.hasVirtualizedHistory &&
    !boundary.hasLiveHead &&
    !liveAuxiliary;

  return (
    <div
      ref={handleScrollContainerRef}
      data-testid="agent-chat-scroll"
      id={`agent-chat-scroll-${shouldUseVirtualizer ? "web-dom-virtualized" : "web-dom-scroll"}`}
      style={scrollContainerStyle}
    >
      <div ref={handleContentRef} style={contentContainerStyle}>
        {historyStartSlot}
        {shouldUseVirtualizer ? (
          <div style={virtualRowsContainerStyle}>
            {virtualRows.map((virtualRow) => {
              const item = segments.historyVirtualized[virtualRow.index];
              if (!item) {
                return null;
              }
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  data-history-row-id={item.id}
                  ref={measureVirtualizedRowElement}
                  style={renderVirtualRowStyle(virtualRow.start)}
                >
                  {renderHistoryVirtualizedRow(item, virtualRow.index, segments.historyVirtualized)}
                </div>
              );
            })}
          </div>
        ) : null}
        {mountedHistoryRows}
        {liveHeadRows}
        {liveAuxiliary}
        {shouldRenderEmpty ? listEmptyComponent : null}
      </div>
    </div>
  );
}

export function createWebStreamStrategy(input: CreateWebStreamStrategyInput): StreamStrategy {
  return createStreamStrategy({
    render: (renderInput) => (
      <WebStreamViewport
        key={renderInput.agentId}
        {...renderInput}
        isMobileBreakpoint={input.isMobileBreakpoint}
      />
    ),
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: "footer",
    historyLiveBoundaryEdge: "last",
    liveHeadHistoryBoundaryEdge: "first",
    frameChildOrder: "content-then-footer",
    flatListInverted: false,
    overlayScrollbarInverted: false,
    maintainVisibleContentPosition: undefined,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 0,
      verificationRetryMode: "rescroll",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: true,
    animateManualScrollToBottom: false,
    useVirtualizedList: false,
    isNearBottom: (inputMetrics) => {
      const distanceFromBottom = Math.max(
        0,
        inputMetrics.contentHeight - (inputMetrics.offsetY + inputMetrics.viewportHeight),
      );
      return distanceFromBottom <= inputMetrics.threshold;
    },
    getBottomOffset: (metrics) => Math.max(0, metrics.contentHeight - metrics.viewportHeight),
  });
}

import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  observeElementOffset,
  measureElement as measureVirtualElement,
  useVirtualizer,
  type Range as VirtualRange,
} from "@tanstack/react-virtual";
import { flushSync } from "react-dom";
import { withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { Theme } from "@/styles/theme";
import { WEB_SCROLLBAR_SIZE_PX } from "@/styles/web-scrollbar";
import { DomOverlayScrollbar } from "@/components/ui/overlay-scrollbar/dom-overlay-scrollbar";
import { estimateStreamItemHeight } from "./web-virtualization";
import { createReadingAnchor } from "./reading-anchor";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import { useRevisedHistoryRows } from "./history-row-revision";
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
import { useChatFindSelectedMessageId } from "@/agent-stream/chat-find";
import { getStreamItemMessageId } from "./presentation";
import { useScrollToMessage } from "./use-scroll-to-message.web";

interface CreateWebStreamStrategyInput {
  isMobileBreakpoint: boolean;
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

interface ActiveFollowOutputLayout {
  scrollContainer: HTMLElement | null;
  viewportWidth: number;
  viewportHeight: number;
  activationKey: string;
  isActivationReady: boolean;
  renderLiveAuxiliary: StreamRenderInput["renderers"]["renderLiveAuxiliary"];
  historyMounted: StreamRenderInput["segments"]["historyMounted"];
  historyVirtualized: StreamRenderInput["segments"]["historyVirtualized"];
  liveHead: StreamRenderInput["segments"]["liveHead"];
  virtualTotalSize: number;
}

function activeFollowOutputLayoutsEqual(
  previous: ActiveFollowOutputLayout,
  next: ActiveFollowOutputLayout,
): boolean {
  return (
    previous.scrollContainer === next.scrollContainer &&
    previous.viewportWidth === next.viewportWidth &&
    previous.viewportHeight === next.viewportHeight &&
    previous.activationKey === next.activationKey &&
    previous.isActivationReady === next.isActivationReady &&
    previous.renderLiveAuxiliary === next.renderLiveAuxiliary &&
    previous.historyMounted === next.historyMounted &&
    previous.historyVirtualized === next.historyVirtualized &&
    previous.liveHead === next.liveHead &&
    previous.virtualTotalSize === next.virtualTotalSize
  );
}

interface ObservedViewportGeometry {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

function getObservedViewportGeometry(scrollContainer: HTMLElement): ObservedViewportGeometry {
  return {
    clientWidth: scrollContainer.clientWidth,
    clientHeight: scrollContainer.clientHeight,
    scrollWidth: scrollContainer.scrollWidth,
    scrollHeight: scrollContainer.scrollHeight,
  };
}

function observedViewportGeometriesEqual(
  previous: ObservedViewportGeometry,
  next: ObservedViewportGeometry,
): boolean {
  return (
    previous.clientWidth === next.clientWidth &&
    previous.clientHeight === next.clientHeight &&
    previous.scrollWidth === next.scrollWidth &&
    previous.scrollHeight === next.scrollHeight
  );
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
    segments: inputSegments,
    historyRowRevision,
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
    contentMaxWidth,
    isMobileBreakpoint,
  } = props;
  const historyVirtualized = useRevisedHistoryRows(
    inputSegments.historyVirtualized,
    historyRowRevision,
  );
  const historyMounted = useRevisedHistoryRows(inputSegments.historyMounted, historyRowRevision);
  const segments = useMemo(
    () => ({ ...inputSegments, historyVirtualized, historyMounted }),
    [historyMounted, historyVirtualized, inputSegments],
  );
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
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const readingAnchor = useMemo(createReadingAnchor, []);
  const measuredRowHeights = useRef(new Map<string, { width: number; height: number }>());
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);
  const lastActiveFollowOutputLayoutRef = useRef<ActiveFollowOutputLayout | null>(null);
  const lastObservedViewportGeometryRef = useRef<ObservedViewportGeometry | null>(null);
  const wasFollowOutputLayoutActiveRef = useRef(false);
  const resumedUnchangedLayoutRef = useRef(false);
  const pendingResumeGeometryCheckRef = useRef(false);
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

  // Chat find counts and highlights occurrences from the DOM, so every block row of
  // the message it selected has to be mounted even when the scroll window is nowhere
  // near it. Without this a hit in a far paragraph is invisible to the count and Next
  // walks off to the following message.
  const chatFindMessageId = useChatFindSelectedMessageId();
  const chatFindRowIndexes = useMemo(() => {
    if (!chatFindMessageId) return null;
    const indexes = segments.historyVirtualized.flatMap((item, index) =>
      getStreamItemMessageId(item) === chatFindMessageId ? [index] : [],
    );
    return indexes.length > 0 ? indexes : null;
  }, [chatFindMessageId, segments.historyVirtualized]);
  const rangeExtractor = useCallback(
    (range: VirtualRange) => {
      const visible = defaultRangeExtractor(range);
      const anchorIndex = segments.historyVirtualized.findIndex(
        (row) => row.id === readingAnchor.getRowId(),
      );
      return [
        ...new Set([
          ...visible,
          ...(chatFindRowIndexes ?? []),
          ...(anchorIndex < 0 ? [] : [anchorIndex]),
        ]),
      ].sort((left, right) => left - right);
    },
    [chatFindRowIndexes, readingAnchor, segments.historyVirtualized],
  );
  const virtualOffsetListener = useRef<((offset: number, scrolling: boolean) => void) | null>(null);
  const observeVirtualOffset = useCallback<typeof observeElementOffset>((instance, onOffset) => {
    virtualOffsetListener.current = onOffset;
    const unsubscribe = observeElementOffset(instance, onOffset);
    return () => {
      virtualOffsetListener.current = null;
      unsubscribe?.();
    };
  }, []);
  const rowVirtualizer = useVirtualizer({
    count: segments.historyVirtualized.length,
    enabled: shouldUseVirtualizer,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index: number) => segments.historyVirtualized[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = segments.historyVirtualized[index];
      const measured = row && measuredRowHeights.current.get(row.id);
      const width = contentRef.current?.getBoundingClientRect().width;
      if (measured && measured.width === width) return measured.height;
      return row ? estimateStreamItemHeight(row, contentMaxWidth) : 120;
    },
    observeElementOffset: observeVirtualOffset,
    rangeExtractor,
    scrollMargin: VIRTUALIZER_SCROLL_MARGIN_PX,
    overscan: 8,
  });
  // Scroll correction belongs to the viewport's committed layout. The virtualizer
  // otherwise writes scrollTop before React applies its new row positions.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
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
      // An explicit jump owns the landing position. Revealing another local
      // page here changes the virtual index before the target has mounted.
      isReady: historyStartReadyRef.current && bottomAnchorSettled && !isJumpSettling(),
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
      if (!transition.shouldLoad || olderHistoryProgressKey === null) {
        return;
      }
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
          return !input || input.isLoadingOlderHistory;
        },
        onSettle: () => {
          const input = getHistoryStartPaginationInput();
          if (!input) {
            return;
          }
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            input,
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  // ResizeObserver runs before paint. Batch measurements and commit React's new
  // positions here so a resized image cannot overlap rows for an extra frame.
  // Use resizeItem exclusively; measureElement would install a second observer.
  const virtualRowObserver = useMemo(
    () =>
      new ResizeObserver((entries) => {
        if (!isActiveRef.current) return;
        flushSync(() => {
          for (const entry of entries) {
            const element = entry.target as HTMLElement;
            if (!element.isConnected) continue;
            rowVirtualizer.resizeItem(
              Number(element.dataset.index),
              measureVirtualElement(element, entry, rowVirtualizer),
            );
          }
        });
      }),
    [rowVirtualizer],
  );
  const measureVirtualizedRowElement = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      virtualRowObserver.observe(node, { box: "border-box" });
      return () => virtualRowObserver.unobserve(node);
    },
    [virtualRowObserver],
  );
  useEffect(() => () => virtualRowObserver.disconnect(), [virtualRowObserver]);

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

  const reconcileReadingPosition = useStableEvent((userScrolled: boolean = false) => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!isActiveRef.current || !container || !content) return;
    const viewportTop = container.getBoundingClientRect().top;
    const scrollTop = container.scrollTop;
    const width = content.getBoundingClientRect().width;
    const rows = Array.from(
      content.querySelectorAll<HTMLElement>("[data-history-row-id]"),
      (element) => {
        const bounds = element.getBoundingClientRect();
        const id = element.dataset.historyRowId!;
        measuredRowHeights.current.set(id, { width, height: bounds.height });
        return { id, top: bounds.top - viewportTop + scrollTop, height: bounds.height };
      },
    );
    if (followOutputRef.current || isJumpSettling()) {
      readingAnchor.reset();
      return;
    }
    const correctedTop = readingAnchor.reconcile(container.scrollTop, rows, userScrolled);
    if (Math.abs(correctedTop - container.scrollTop) > 0.5) {
      container.scrollTop = correctedTop;
      lastKnownScrollTopRef.current = container.scrollTop;
      // The DOM scroll event arrives later. Fill the corrected virtual range in
      // this layout so the reader does not get a frame containing only the pin.
      virtualOffsetListener.current?.(container.scrollTop, false);
    }
  });

  // Apply row positions and their scroll correction in the same paint, including
  // the ordinary-to-virtualized handoff and measurements of newly mounted rows.
  useLayoutEffect(() => {
    reconcileReadingPosition();
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
    reconcileReadingPosition(scrolledUp || scrolledDown);
    updateScrollMetrics();
    evaluateHistoryStart();
  }, [
    evaluateHistoryStart,
    isJumpSettling,
    reconcileReadingPosition,
    stopFollowingOutputFromUserIntent,
    updateScrollMetrics,
  ]);

  useEffect(() => {
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    readingAnchor.reset();
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
  }, [evaluateHistoryStart, props.agentId, readingAnchor]);

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
    const layout: ActiveFollowOutputLayout = {
      scrollContainer: scrollContainerRef.current,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      activationKey,
      isActivationReady,
      renderLiveAuxiliary,
      historyMounted: segments.historyMounted,
      historyVirtualized: segments.historyVirtualized,
      liveHead: segments.liveHead,
      virtualTotalSize,
    };
    const resumedUnchangedLayout = Boolean(
      isActive &&
      !wasFollowOutputLayoutActiveRef.current &&
      lastActiveFollowOutputLayoutRef.current &&
      activeFollowOutputLayoutsEqual(lastActiveFollowOutputLayoutRef.current, layout),
    );
    resumedUnchangedLayoutRef.current = resumedUnchangedLayout;
    pendingResumeGeometryCheckRef.current = resumedUnchangedLayout;
    wasFollowOutputLayoutActiveRef.current = isActive;
    if (!isActive) {
      return;
    }
    lastActiveFollowOutputLayoutRef.current = layout;
    if (!followOutputRef.current || resumedUnchangedLayout) return;
    cancelPendingStickToBottom();
    scrollMessagesToBottom("auto");
  }, [
    activationKey,
    cancelPendingStickToBottom,
    isActive,
    isActivationReady,
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
    const resumedUnchangedLayout = resumedUnchangedLayoutRef.current;
    resumedUnchangedLayoutRef.current = false;
    if (!resumedUnchangedLayout) {
      updateScrollMetrics();
    }
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

    if (!pendingResumeGeometryCheckRef.current) {
      updateScrollMetrics();
      evaluateHistoryStart();
    }
    const observer = new ResizeObserver(() => {
      const nextGeometry = getObservedViewportGeometry(scrollContainer);
      if (pendingResumeGeometryCheckRef.current) {
        pendingResumeGeometryCheckRef.current = false;
        reportReadingPosition();
        const previousGeometry = lastObservedViewportGeometryRef.current;
        lastObservedViewportGeometryRef.current = nextGeometry;
        if (previousGeometry && observedViewportGeometriesEqual(previousGeometry, nextGeometry)) {
          return;
        }
      } else {
        lastObservedViewportGeometryRef.current = nextGeometry;
      }
      reconcileReadingPosition();
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
    reconcileReadingPosition,
    evaluateHistoryStart,
    isActive,
    reportReadingPosition,
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
    const overlayScrollbarEnabled = scrollEnabled && !isMobileBreakpoint;
    return {
      width: "100%",
      height: "100%",
      overflowX: "hidden",
      overflowY: scrollEnabled ? "auto" : "hidden",
      overscrollBehaviorY: "contain",
      // The browser still anchors delayed image growth while following output.
      // Detached reading has one owner: reconcileReadingPosition.
      overflowAnchor: followOutput ? "auto" : "none",
      scrollbarWidth: overlayScrollbarEnabled ? "none" : undefined,
    };
  }, [followOutput, isMobileBreakpoint, scrollEnabled]);
  const viewportStyle = useMemo(
    (): CSSProperties => ({
      position: "relative",
      flex: 1,
      minWidth: 0,
      minHeight: 0,
    }),
    [],
  );
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
      <div
        key={item.id}
        data-history-row-id={item.id}
        data-message-id={getStreamItemMessageId(item)}
        style={streamRowStyle}
      >
        {renderHistoryMountedRow(item, index, segments.historyMounted)}
      </div>
    ));
  }, [renderHistoryMountedRow, segments.historyMounted]);
  const liveHeadRows = useMemo(() => {
    void liveHeadRowRevision;
    return segments.liveHead.map((item, index) => (
      <div
        key={item.id}
        data-history-row-id={item.id}
        data-message-id={getStreamItemMessageId(item)}
        style={streamRowStyle}
      >
        {renderLiveHeadRow(item, index, segments.liveHead)}
      </div>
    ));
  }, [liveHeadRowRevision, renderLiveHeadRow, segments.liveHead]);
  const mountedRows = useMemo(
    () => [...mountedHistoryRows, ...liveHeadRows],
    [liveHeadRows, mountedHistoryRows],
  );
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
    <div style={viewportStyle}>
      <div
        ref={handleScrollContainerRef}
        data-testid="agent-chat-scroll"
        data-overlay-scrollbar={scrollEnabled && !isMobileBreakpoint ? "true" : undefined}
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
                    data-message-id={getStreamItemMessageId(item)}
                    ref={measureVirtualizedRowElement}
                    style={renderVirtualRowStyle(virtualRow.start)}
                  >
                    {renderHistoryVirtualizedRow(
                      item,
                      virtualRow.index,
                      segments.historyVirtualized,
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {mountedRows}
          {liveAuxiliary}
          {shouldRenderEmpty ? listEmptyComponent : null}
        </div>
      </div>
      {scrollEnabled && !isMobileBreakpoint ? (
        <DomOverlayScrollbar
          scrollContainerRef={scrollContainerRef}
          onUserScrollUp={stopFollowingOutputFromUserIntent}
        />
      ) : null}
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

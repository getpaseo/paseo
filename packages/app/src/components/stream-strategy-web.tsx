import {
  Fragment,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";
import { estimateStreamItemHeight } from "./agent-stream-web-virtualization";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./stream-strategy";
import { createStreamStrategy } from "./stream-strategy";

type CreateWebStreamStrategyInput = {
  isMobileBreakpoint: boolean;
};

type ScrollBehaviorLike = "auto" | "smooth";

const WEB_BOTTOM_SETTLE_TIMEOUT_MS = 200;
const USER_SCROLL_DELTA_EPSILON = 1;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1;
import { useWebElementScrollbar } from "./use-web-scrollbar";

function logWebStickyBottom(_event: string, _details: Record<string, unknown>): void {
  // Intentionally disabled: this path is too noisy during voice debugging.
}

function getDebugNow(): number | null {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return Number(performance.now().toFixed(3));
  }
  return null;
}

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
  return getScrollContainerDistanceFromBottom(scrollContainer) < 0;
}

function WebStreamViewport(props: StreamRenderInput & { isMobileBreakpoint: boolean }) {
  const {
    segments,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    scrollEnabled,
    isMobileBreakpoint,
  } = props;
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const [followOutput, setFollowOutputr] = useState(true);
  const setFollowOutput = (value: boolean) => {
    setFollowOutputr(value);
    return value;
  };
  const followOutputRef = useRef(followOutput);
  const lastKnownScrollTopRef = useRef(0);
  const lastLoggedMetricsRef = useRef<{
    scrollTop: number;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
  } | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingAutoScrollTimeoutRef = useRef<number | null>(null);
  const showDesktopWebScrollbar = !isMobileBreakpoint;
  const scrollbarOverlay = useWebElementScrollbar(scrollContainerRef, {
    enabled: showDesktopWebScrollbar,
    contentRef,
  });
  const shouldUseVirtualizer = segments.historyVirtualized.length > 0;
  const {
    renderHistoryVirtualizedRow,
    renderHistoryMountedRow,
    renderLiveHeadRow,
    renderLiveAuxiliary,
  } = renderers;

  followOutputRef.current = followOutput;

  const activationKey = routeBottomAnchorRequest?.requestKey ?? props.agentId;
  const isActivationReady = routeBottomAnchorRequest === null || isAuthoritativeHistoryReady;

  const rowVirtualizer = useVirtualizer({
    count: segments.historyVirtualized.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index: number) => segments.historyVirtualized[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = segments.historyVirtualized[index];
      return row ? estimateStreamItemHeight(row) : 120;
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      logWebStickyBottom("virtualizer_item_size_change", {
        agentId: props.agentId,
        delta: _delta,
        itemIndex: _item.index,
        itemStart: _item.start,
        itemSize: _item.size,
        viewportHeight,
        scrollOffset,
        totalSize: instance.getTotalSize(),
        remainingDistance,
      });
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();

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

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehaviorLike = "auto") => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      if (isScrollContainerOverscrolledPastBottom(scrollContainer)) {
        return;
      }
      logWebStickyBottom("viewport_scroll_to_bottom", {
        agentId: props.agentId,
        behavior,
        followOutput: followOutputRef.current,
        scrollTop: scrollContainer.scrollTop,
        clientWidth: scrollContainer.clientWidth,
        clientHeight: scrollContainer.clientHeight,
        scrollWidth: scrollContainer.scrollWidth,
        scrollHeight: scrollContainer.scrollHeight,
      });
      scrollElementToBottom(scrollContainer, behavior);
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      syncNearBottom(scrollContainer, onNearBottomChange);
    },
    [onNearBottomChange, props.agentId],
  );

  const scheduleStickToBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer && isScrollContainerOverscrolledPastBottom(scrollContainer)) {
      return;
    }
    if (pendingAutoScrollFrameRef.current !== null) {
      return;
    }
    logWebStickyBottom("viewport_schedule_stick_to_bottom", {
      agentId: props.agentId,
      followOutput: followOutputRef.current,
      scrollTop: scrollContainer?.scrollTop ?? null,
      clientWidth: scrollContainer?.clientWidth ?? null,
      clientHeight: scrollContainer?.clientHeight ?? null,
      scrollWidth: scrollContainer?.scrollWidth ?? null,
      scrollHeight: scrollContainer?.scrollHeight ?? null,
    });
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      if (!followOutputRef.current) {
        return;
      }
      scrollMessagesToBottom("auto");
    });
  }, [props.agentId, scrollMessagesToBottom]);

  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom("auto");
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);

  const updateScrollMetrics = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      onNearBottomChange(true);
      return;
    }
    syncNearBottom(scrollContainer, onNearBottomChange);
    const currentMetrics = {
      scrollTop: scrollContainer.scrollTop,
      clientWidth: scrollContainer.clientWidth,
      clientHeight: scrollContainer.clientHeight,
      scrollWidth: scrollContainer.scrollWidth,
      scrollHeight: scrollContainer.scrollHeight,
    };
    const previousMetrics = lastLoggedMetricsRef.current;
    const shouldLog =
      !previousMetrics ||
      previousMetrics.scrollTop !== currentMetrics.scrollTop ||
      previousMetrics.clientWidth !== currentMetrics.clientWidth ||
      previousMetrics.clientHeight !== currentMetrics.clientHeight ||
      previousMetrics.scrollWidth !== currentMetrics.scrollWidth ||
      previousMetrics.scrollHeight !== currentMetrics.scrollHeight;
    if (shouldLog) {
      lastLoggedMetricsRef.current = currentMetrics;
      logWebStickyBottom("viewport_metrics_updated", {
        agentId: props.agentId,
        followOutput: followOutputRef.current,
        distanceFromBottom: getScrollContainerDistanceFromBottom(scrollContainer),
        ...currentMetrics,
      });
    }
  }, [onNearBottomChange, props.agentId]);

  const handleDomScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const currentScrollTop = scrollContainer.scrollTop;
    const isAtBottom = isScrollContainerAtBottom(scrollContainer);
    const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - USER_SCROLL_DELTA_EPSILON;

    if (!followOutputRef.current && isAtBottom) {
      setFollowOutput(true);
      pendingUserScrollUpIntentRef.current = false;
    } else if (followOutputRef.current && pendingUserScrollUpIntentRef.current) {
      if (scrolledUp) {
        cancelPendingStickToBottom();
        setFollowOutput(false);
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (followOutputRef.current && isPointerScrollActiveRef.current) {
      if (scrolledUp) {
        cancelPendingStickToBottom();
        setFollowOutput(false);
      }
    }

    lastKnownScrollTopRef.current = currentScrollTop;
    logWebStickyBottom("viewport_dom_scroll", {
      agentId: props.agentId,
      now: getDebugNow(),
      scrollTop: currentScrollTop,
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
      activeElementTag:
        typeof document !== "undefined"
          ? (document.activeElement?.tagName?.toLowerCase() ?? null)
          : null,
      activeElementRole:
        typeof document !== "undefined"
          ? (document.activeElement?.getAttribute?.("aria-label") ?? null)
          : null,
    });
    updateScrollMetrics();
  }, [cancelPendingStickToBottom, updateScrollMetrics]);

  useLayoutEffect(() => {
    if (!isActivationReady) {
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
  }, [activationKey, forceStickToBottom, isActivationReady, scheduleStickToBottom]);

  useEffect(() => {
    if (!followOutputRef.current) {
      return;
    }
    scheduleStickToBottom();
  }, [
    scheduleStickToBottom,
    segments.historyMounted,
    segments.historyVirtualized,
    segments.liveHead,
  ]);

  useEffect(() => {
    if (!followOutputRef.current || !shouldUseVirtualizer) {
      return;
    }
    scheduleStickToBottom();
  }, [scheduleStickToBottom, shouldUseVirtualizer, virtualTotalSize]);

  useEffect(() => {
    updateScrollMetrics();
  }, [
    segments.historyMounted.length,
    segments.historyVirtualized.length,
    segments.liveHead.length,
    updateScrollMetrics,
    virtualTotalSize,
  ]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }

    updateScrollMetrics();
    const observer = new ResizeObserver(() => {
      logWebStickyBottom("viewport_resize_observed", {
        agentId: props.agentId,
        followOutput: followOutputRef.current,
        scrollTop: scrollContainer.scrollTop,
        clientWidth: scrollContainer.clientWidth,
        clientHeight: scrollContainer.clientHeight,
        scrollWidth: scrollContainer.scrollWidth,
        scrollHeight: scrollContainer.scrollHeight,
      });
      updateScrollMetrics();
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
  }, [props.agentId, scheduleStickToBottom, updateScrollMetrics]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const originalScrollTo = scrollContainer.scrollTo.bind(scrollContainer);
    const scrollTopDescriptor =
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(scrollContainer), "scrollTop") ??
      Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    scrollContainer.scrollTo = ((...args: Parameters<HTMLElement["scrollTo"]>) => {
      const firstArg = args[0] as ScrollToOptions | number | undefined;
      const target =
        typeof firstArg === "object" && firstArg !== null
          ? {
              top: firstArg.top ?? null,
              left: firstArg.left ?? null,
              behavior: firstArg.behavior ?? null,
            }
          : {
              top: typeof args[1] === "number" ? args[1] : null,
              left: typeof firstArg === "number" ? firstArg : null,
              behavior: null,
            };
      logWebStickyBottom("viewport_scroll_to_called", {
        agentId: props.agentId,
        now: getDebugNow(),
        currentScrollTop: scrollContainer.scrollTop,
        target,
        stack:
          typeof Error !== "undefined"
            ? (new Error().stack?.split("\n").slice(1, 6).join("\n") ?? null)
            : null,
      });
      return originalScrollTo(...args);
    }) as typeof scrollContainer.scrollTo;
    if (scrollTopDescriptor?.get && scrollTopDescriptor?.set) {
      Object.defineProperty(scrollContainer, "scrollTop", {
        configurable: true,
        enumerable: scrollTopDescriptor.enumerable ?? false,
        get() {
          return scrollTopDescriptor.get?.call(scrollContainer);
        },
        set(value: number) {
          logWebStickyBottom("viewport_scroll_top_set", {
            agentId: props.agentId,
            now: getDebugNow(),
            currentScrollTop: scrollTopDescriptor.get?.call(scrollContainer) ?? null,
            nextScrollTop: value,
            stack:
              typeof Error !== "undefined"
                ? (new Error().stack?.split("\n").slice(1, 6).join("\n") ?? null)
                : null,
          });
          return scrollTopDescriptor.set?.call(scrollContainer, value);
        },
      });
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pendingUserScrollUpIntentRef.current = true;
        cancelPendingStickToBottom();
      }
    };
    const handlePointerDown = () => {
      isPointerScrollActiveRef.current = true;
    };
    const handlePointerUp = () => {
      isPointerScrollActiveRef.current = false;
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
      if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
        pendingUserScrollUpIntentRef.current = true;
        cancelPendingStickToBottom();
      }
      lastTouchClientYRef.current = touch.clientY;
    };
    const handleTouchEnd = () => {
      lastTouchClientYRef.current = null;
    };
    const handleSelectionChange = () => {
      const activeElement =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLTextAreaElement | null)
          : null;
      logWebStickyBottom("document_selection_changed", {
        agentId: props.agentId,
        now: getDebugNow(),
        activeElementTag: activeElement?.tagName?.toLowerCase() ?? null,
        activeElementRole: activeElement?.getAttribute?.("aria-label") ?? null,
        selectionStart:
          activeElement && typeof activeElement.selectionStart === "number"
            ? activeElement.selectionStart
            : null,
        selectionEnd:
          activeElement && typeof activeElement.selectionEnd === "number"
            ? activeElement.selectionEnd
            : null,
        scrollTop: scrollContainer.scrollTop,
      });
    };

    scrollContainer.addEventListener("scroll", handleDomScroll, { passive: true });
    scrollContainer.addEventListener("wheel", handleWheel, { passive: true });
    scrollContainer.addEventListener("pointerdown", handlePointerDown, { passive: true });
    scrollContainer.addEventListener("pointerup", handlePointerUp, { passive: true });
    scrollContainer.addEventListener("pointercancel", handlePointerUp, { passive: true });
    scrollContainer.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollContainer.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollContainer.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollContainer.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    if (typeof document !== "undefined") {
      document.addEventListener("selectionchange", handleSelectionChange, { passive: true });
    }

    return () => {
      scrollContainer.removeEventListener("scroll", handleDomScroll);
      scrollContainer.removeEventListener("wheel", handleWheel);
      scrollContainer.removeEventListener("pointerdown", handlePointerDown);
      scrollContainer.removeEventListener("pointerup", handlePointerUp);
      scrollContainer.removeEventListener("pointercancel", handlePointerUp);
      scrollContainer.removeEventListener("touchstart", handleTouchStart);
      scrollContainer.removeEventListener("touchmove", handleTouchMove);
      scrollContainer.removeEventListener("touchend", handleTouchEnd);
      scrollContainer.removeEventListener("touchcancel", handleTouchEnd);
      scrollContainer.scrollTo = originalScrollTo;
      if (scrollTopDescriptor) {
        Reflect.deleteProperty(scrollContainer, "scrollTop");
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("selectionchange", handleSelectionChange);
      }
    };
  }, [cancelPendingStickToBottom, handleDomScroll, props.agentId]);

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
        const scrollContainer = scrollContainerRef.current;
        logWebStickyBottom("viewport_prepare_for_change", {
          agentId: props.agentId,
          followOutput: followOutputRef.current,
          scrollTop: scrollContainer?.scrollTop ?? null,
          clientWidth: scrollContainer?.clientWidth ?? null,
          clientHeight: scrollContainer?.clientHeight ?? null,
          scrollWidth: scrollContainer?.scrollWidth ?? null,
          scrollHeight: scrollContainer?.scrollHeight ?? null,
        });
        scheduleStickToBottom();
      },
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
    props.agentId,
    scheduleStickToBottom,
    viewportRef,
  ]);

  const contentContainerStyle = useMemo(
    (): CSSProperties => ({
      display: "flex",
      flexDirection: "column",
      minHeight: "100%",
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: isMobileBreakpoint ? 8 : 16,
      paddingRight: isMobileBreakpoint ? 8 : 16,
      boxSizing: "border-box",
    }),
    [isMobileBreakpoint],
  );
  const scrollContainerStyle = useMemo(
    (): CSSProperties => ({
      flex: 1,
      minHeight: 0,
      overflowX: "hidden",
      overflowY: scrollEnabled ? "auto" : "hidden",
      overscrollBehaviorY: "contain",
    }),
    [scrollEnabled],
  );
  const virtualRowsContainerStyle = useMemo(
    (): CSSProperties => ({
      position: "relative",
      width: "100%",
      height: virtualTotalSize,
    }),
    [virtualTotalSize],
  );
  const renderVirtualRowStyle = useCallback(
    (start: number): CSSProperties => ({
      position: "absolute",
      top: 0,
      left: 0,
      display: "flex",
      flexDirection: "column",
      width: "100%",
      transform: `translateY(${start}px)`,
    }),
    [],
  );
  const mountedHistoryRows = useMemo(
    () =>
      segments.historyMounted.map((item, index) => (
        <Fragment key={item.id}>
          {renderHistoryMountedRow(item, index, segments.historyMounted)}
        </Fragment>
      )),
    [renderHistoryMountedRow, segments.historyMounted],
  );
  const liveHeadRows = useMemo(
    () =>
      segments.liveHead.map((item, index) => (
        <Fragment key={item.id}>{renderLiveHeadRow(item, index, segments.liveHead)}</Fragment>
      )),
    [renderLiveHeadRow, segments.liveHead],
  );
  const liveAuxiliary = useMemo(() => renderLiveAuxiliary(), [renderLiveAuxiliary]);
  const shouldRenderEmpty =
    !boundary.hasMountedHistory &&
    !boundary.hasVirtualizedHistory &&
    !boundary.hasLiveHead &&
    !liveAuxiliary;

  return (
    <>
      <div
        ref={(node) => {
          scrollContainerRef.current = node;
        }}
        data-testid="agent-chat-scroll"
        id={`agent-chat-scroll-${shouldUseVirtualizer ? "web-dom-virtualized" : "web-dom-scroll"}`}
        style={scrollContainerStyle}
      >
        <div
          ref={(node) => {
            contentRef.current = node;
          }}
          style={contentContainerStyle}
        >
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
                    ref={rowVirtualizer.measureElement}
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
          {mountedHistoryRows}
          {boundary.hasMountedHistory && boundary.hasLiveHead && boundary.historyToHeadGap > 0 ? (
            <div style={{ height: boundary.historyToHeadGap, width: "100%" }} />
          ) : null}
          {liveHeadRows}
          {liveAuxiliary}
          {shouldRenderEmpty ? listEmptyComponent : null}
        </div>
      </div>
      {scrollbarOverlay}
    </>
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

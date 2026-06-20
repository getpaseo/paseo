import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator } from "react-native";
import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";
import { useWebElementScrollbar } from "@/components/use-web-scrollbar";
import { useAppSettings } from "@/hooks/use-settings";
import { estimateStreamItemHeight } from "./web-virtualization";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import { createStreamStrategy } from "./strategy";
import type { StreamItem } from "@/types/stream";

interface CreateWebStreamStrategyInput {
  isMobileBreakpoint: boolean;
}

type ScrollBehaviorLike = "auto" | "smooth";

const WEB_BOTTOM_SETTLE_TIMEOUT_MS = 200;
const USER_SCROLL_DELTA_EPSILON = 1;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1;
const HISTORY_START_THRESHOLD_PX = 96;
const PROMPT_MARKER_SIZE = 6;
const PROMPT_MARKER_HIT_SIZE = 28;
const PROMPT_MARKER_RAIL_RIGHT = 10;
const PROMPT_PREVIEW_WIDTH = 280;
const PROMPT_PREVIEW_MAX_HEIGHT = 120;
const PROMPT_PREVIEW_EDGE_PADDING = 16;
const PROMPT_PREVIEW_TEXT_MAX_LENGTH = 140;
const PROMPT_SCROLL_TARGET_TOP_PADDING = 15;

type PromptMarkerSegment = "virtualizedHistory" | "mountedHistory" | "liveHead";

interface PromptMarkerDescriptor {
  id: string;
  text: string;
  index: number;
  segment: PromptMarkerSegment;
}

interface PromptMarker extends PromptMarkerDescriptor {
  targetOffset: number;
}

interface PromptRailMetrics {
  viewportSize: number;
  contentSize: number;
  offsetsById: Map<string, number>;
}

const historyStartSlotStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 32,
  paddingTop: 4,
  paddingBottom: 8,
};

const streamItemAnchorStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
};

const promptMarkerOverlayStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  right: PROMPT_MARKER_RAIL_RIGHT,
  bottom: 0,
  width: PROMPT_MARKER_HIT_SIZE,
  pointerEvents: "none",
  zIndex: 11,
};

const promptMarkerTargetBaseStyle: CSSProperties = {
  position: "absolute",
  right: 0,
  width: PROMPT_MARKER_HIT_SIZE,
  height: PROMPT_MARKER_HIT_SIZE,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "auto",
  cursor: "pointer",
};

const promptMarkerDotBaseStyle: CSSProperties = {
  width: PROMPT_MARKER_SIZE,
  height: PROMPT_MARKER_SIZE,
  borderRadius: 999,
  backgroundColor: "var(--colors-surface3, #e4e4e7)",
  border: "1px solid rgba(0, 0, 0, 0.16)",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.28)",
};

const promptPreviewBaseStyle: CSSProperties = {
  position: "absolute",
  right: PROMPT_MARKER_HIT_SIZE,
  width: PROMPT_PREVIEW_WIDTH,
  maxHeight: PROMPT_PREVIEW_MAX_HEIGHT,
  overflow: "hidden",
  padding: 16,
  borderRadius: 16,
  borderTopRightRadius: 2,
  backgroundColor: "var(--colors-surface3, #e4e4e7)",
  color: "var(--colors-foreground, #1a1a1e)",
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.24)",
  fontSize: 16,
  lineHeight: "22px",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  textAlign: "left",
  transition: "opacity 120ms ease-out, transform 120ms ease-out",
};

const promptPreviewHiddenStyle: CSSProperties = {
  opacity: 0,
  pointerEvents: "none",
  transform: "translateX(4px)",
};

const promptPreviewVisibleStyle: CSSProperties = {
  opacity: 1,
  pointerEvents: "auto",
  transform: "translateX(0)",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function arePromptRailMetricsEqual(left: PromptRailMetrics, right: PromptRailMetrics): boolean {
  if (
    left.viewportSize !== right.viewportSize ||
    left.contentSize !== right.contentSize ||
    left.offsetsById.size !== right.offsetsById.size
  ) {
    return false;
  }

  for (const [id, offset] of left.offsetsById) {
    if (right.offsetsById.get(id) !== offset) {
      return false;
    }
  }
  return true;
}

function collectPromptMarkerDescriptors(
  segments: StreamRenderInput["segments"],
): PromptMarkerDescriptor[] {
  const markers: PromptMarkerDescriptor[] = [];
  const visit = (items: StreamItem[], segment: PromptMarkerSegment) => {
    items.forEach((item, index) => {
      if (item.kind !== "user_message") {
        return;
      }
      markers.push({
        id: item.id,
        text: item.text,
        index,
        segment,
      });
    });
  };

  visit(segments.historyVirtualized, "virtualizedHistory");
  visit(segments.historyMounted, "mountedHistory");
  visit(segments.liveHead, "liveHead");
  return markers;
}

function findStreamItemAnchor(
  contentElement: HTMLElement | null,
  itemId: string,
): HTMLElement | null {
  if (!contentElement) {
    return null;
  }
  const anchors = contentElement.querySelectorAll<HTMLElement>("[data-stream-item-id]");
  for (const anchor of anchors) {
    if (anchor.dataset.streamItemId === itemId) {
      return anchor;
    }
  }
  return null;
}

function getPromptMarkerTop(input: {
  targetOffset: number;
  viewportSize: number;
  contentSize: number;
}): number {
  const maxMarkerTop = Math.max(0, input.viewportSize - PROMPT_MARKER_HIT_SIZE);
  if (input.contentSize <= 0) {
    return 0;
  }
  const clampedTarget = clamp(input.targetOffset, 0, input.contentSize);
  return (clampedTarget / input.contentSize) * maxMarkerTop;
}

function getPromptPreviewTop(input: { markerTop: number; viewportSize: number }): number {
  const dotTop = input.markerTop + (PROMPT_MARKER_HIT_SIZE - PROMPT_MARKER_SIZE) / 2;
  const maxTop = Math.max(
    PROMPT_PREVIEW_EDGE_PADDING,
    input.viewportSize - PROMPT_PREVIEW_EDGE_PADDING - PROMPT_PREVIEW_MAX_HEIGHT,
  );
  return clamp(dotTop, PROMPT_PREVIEW_EDGE_PADDING, maxTop);
}

function getPromptPreviewText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PROMPT_PREVIEW_TEXT_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, PROMPT_PREVIEW_TEXT_MAX_LENGTH - 3).trimEnd()}...`;
}

interface PromptMarkerRailProps {
  markers: PromptMarker[];
  viewportSize: number;
  contentSize: number;
  onMarkerPress: (marker: PromptMarker) => void;
}

interface PromptMarkerRailItemProps {
  marker: PromptMarker;
  markerTop: number;
  previewTop: number;
  isHovered: boolean;
  onMarkerPress: (marker: PromptMarker) => void;
  onHoveredPromptChange: (promptId: string | null) => void;
}

function PromptMarkerRailItem({
  marker,
  markerTop,
  previewTop,
  isHovered,
  onMarkerPress,
  onHoveredPromptChange,
}: PromptMarkerRailItemProps) {
  const previewText = useMemo(() => getPromptPreviewText(marker.text), [marker.text]);
  const targetStyle = useMemo(
    (): CSSProperties => ({
      ...promptMarkerTargetBaseStyle,
      top: markerTop,
      border: 0,
      padding: 0,
      background: "transparent",
    }),
    [markerTop],
  );
  const previewStyle = useMemo(
    (): CSSProperties => ({
      ...promptPreviewBaseStyle,
      top: previewTop - markerTop,
      ...(isHovered ? promptPreviewVisibleStyle : promptPreviewHiddenStyle),
    }),
    [isHovered, markerTop, previewTop],
  );
  const handleClick = useCallback(() => {
    onMarkerPress(marker);
  }, [marker, onMarkerPress]);
  const handleMouseEnter = useCallback(() => {
    onHoveredPromptChange(marker.id);
  }, [marker.id, onHoveredPromptChange]);
  const handleMouseLeave = useCallback(() => {
    onHoveredPromptChange(null);
  }, [onHoveredPromptChange]);

  return (
    <button
      type="button"
      data-testid={`prompt-scroll-marker-${marker.id}`}
      aria-label="Jump to prompt"
      style={targetStyle}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span style={promptMarkerDotBaseStyle} />
      <span data-testid={`prompt-scroll-preview-${marker.id}`} style={previewStyle}>
        {previewText}
      </span>
    </button>
  );
}

function PromptMarkerRail({
  markers,
  viewportSize,
  contentSize,
  onMarkerPress,
}: PromptMarkerRailProps) {
  const [hoveredPromptId, setHoveredPromptId] = useState<string | null>(null);
  const handleHoveredPromptChange = useCallback((promptId: string | null) => {
    setHoveredPromptId(promptId);
  }, []);

  if (markers.length === 0 || contentSize <= viewportSize || viewportSize <= 0) {
    return null;
  }

  return (
    <div style={promptMarkerOverlayStyle} data-testid="prompt-marker-rail">
      {markers.map((marker) => {
        const markerTop = getPromptMarkerTop({
          targetOffset: marker.targetOffset,
          viewportSize,
          contentSize,
        });
        const previewTop = getPromptPreviewTop({ markerTop, viewportSize });
        const isHovered = hoveredPromptId === marker.id;
        return (
          <PromptMarkerRailItem
            key={marker.id}
            marker={marker}
            markerTop={markerTop}
            previewTop={previewTop}
            isHovered={isHovered}
            onMarkerPress={onMarkerPress}
            onHoveredPromptChange={handleHoveredPromptChange}
          />
        );
      })}
    </div>
  );
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
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    scrollEnabled,
    isMobileBreakpoint,
  } = props;
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const virtualRowsContainerRef = useRef<HTMLDivElement | null>(null);
  const handleScrollContainerRef = useCallback((node: HTMLElement | null) => {
    scrollContainerRef.current = node;
  }, []);
  const handleContentRef = useCallback((node: HTMLElement | null) => {
    contentRef.current = node;
  }, []);
  const [followOutput, setFollowOutputr] = useState(true);
  const setFollowOutput = (value: boolean) => {
    setFollowOutputr(value);
    return value;
  };
  const followOutputRef = useRef(followOutput);
  const lastKnownScrollTopRef = useRef(0);
  const pendingUserScrollUpIntentRef = useRef(false);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingAutoScrollTimeoutRef = useRef<number | null>(null);
  const pendingVirtualRowMeasureFramesRef = useRef(new Map<Element, number>());
  const historyStartReadyRef = useRef(false);
  const { settings: appSettings } = useAppSettings();
  const [promptRailMetrics, setPromptRailMetrics] = useState<PromptRailMetrics>({
    viewportSize: 0,
    contentSize: 0,
    offsetsById: new Map(),
  });
  const showDesktopWebScrollbar = !isMobileBreakpoint;
  const showPromptMarkers = showDesktopWebScrollbar && appSettings.promptScrollMarkers;
  const promptMarkerDescriptors = useMemo(
    () => collectPromptMarkerDescriptors(segments),
    [segments],
  );
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
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();

  const getVirtualPromptOffset = useCallback(
    (index: number): number | null => {
      const offsetInfo = rowVirtualizer.getOffsetForIndex(index, "start");
      if (!offsetInfo) {
        return null;
      }
      const virtualRowsContainerOffset = virtualRowsContainerRef.current?.offsetTop ?? 0;
      return virtualRowsContainerOffset + offsetInfo[0];
    },
    [rowVirtualizer],
  );

  const resolvePromptOffset = useCallback(
    (marker: PromptMarkerDescriptor): number | null => {
      if (marker.segment === "virtualizedHistory") {
        return getVirtualPromptOffset(marker.index);
      }
      const anchor = findStreamItemAnchor(contentRef.current, marker.id);
      return anchor?.offsetTop ?? null;
    },
    [getVirtualPromptOffset],
  );

  const updatePromptRailMetrics = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || !showPromptMarkers) {
      setPromptRailMetrics((previous) => {
        const next: PromptRailMetrics = {
          viewportSize: 0,
          contentSize: 0,
          offsetsById: new Map(),
        };
        return arePromptRailMetricsEqual(previous, next) ? previous : next;
      });
      return;
    }

    const offsetsById = new Map<string, number>();
    for (const marker of promptMarkerDescriptors) {
      const offset = resolvePromptOffset(marker);
      if (offset !== null) {
        offsetsById.set(marker.id, offset);
      }
    }

    const next: PromptRailMetrics = {
      viewportSize: scrollContainer.clientHeight,
      contentSize: scrollContainer.scrollHeight,
      offsetsById,
    };
    setPromptRailMetrics((previous) =>
      arePromptRailMetricsEqual(previous, next) ? previous : next,
    );
  }, [promptMarkerDescriptors, resolvePromptOffset, showPromptMarkers]);

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
        if (node.isConnected) {
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

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehaviorLike = "auto") => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      if (isScrollContainerOverscrolledPastBottom(scrollContainer)) {
        return;
      }
      scrollElementToBottom(scrollContainer, behavior);
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      syncNearBottom(scrollContainer, onNearBottomChange);
    },
    [onNearBottomChange],
  );

  const scheduleStickToBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer && isScrollContainerOverscrolledPastBottom(scrollContainer)) {
      return;
    }
    if (pendingAutoScrollFrameRef.current !== null) {
      return;
    }
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      if (!followOutputRef.current) {
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

  const updateScrollMetrics = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      onNearBottomChange(true);
      return;
    }
    syncNearBottom(scrollContainer, onNearBottomChange);
  }, [onNearBottomChange]);

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
    updateScrollMetrics();
    if (
      showPromptMarkers &&
      (scrollContainer.clientHeight !== promptRailMetrics.viewportSize ||
        scrollContainer.scrollHeight !== promptRailMetrics.contentSize)
    ) {
      updatePromptRailMetrics();
    }
    if (
      historyStartReadyRef.current &&
      hasOlderHistory &&
      currentScrollTop <= HISTORY_START_THRESHOLD_PX
    ) {
      onNearHistoryStart();
    }
  }, [
    cancelPendingStickToBottom,
    hasOlderHistory,
    onNearHistoryStart,
    promptRailMetrics.contentSize,
    promptRailMetrics.viewportSize,
    showPromptMarkers,
    updatePromptRailMetrics,
    updateScrollMetrics,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      historyStartReadyRef.current = false;
    };
  }, [props.agentId]);

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

  useLayoutEffect(() => {
    updatePromptRailMetrics();
  }, [
    segments.historyMounted,
    segments.historyVirtualized,
    segments.liveHead,
    updatePromptRailMetrics,
    virtualTotalSize,
  ]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }

    updateScrollMetrics();
    updatePromptRailMetrics();
    const observer = new ResizeObserver(() => {
      updateScrollMetrics();
      updatePromptRailMetrics();
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
  }, [scheduleStickToBottom, updatePromptRailMetrics, updateScrollMetrics]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
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

    scrollContainer.addEventListener("scroll", handleDomScroll, { passive: true });
    scrollContainer.addEventListener("wheel", handleWheel, { passive: true });
    scrollContainer.addEventListener("pointerdown", handlePointerDown, { passive: true });
    scrollContainer.addEventListener("pointerup", handlePointerUp, { passive: true });
    scrollContainer.addEventListener("pointercancel", handlePointerUp, { passive: true });
    scrollContainer.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollContainer.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollContainer.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollContainer.addEventListener("touchcancel", handleTouchEnd, { passive: true });

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
    };
  }, [cancelPendingStickToBottom, handleDomScroll]);

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
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
      cancelPendingStickToBottom();
    };
  }, [cancelPendingStickToBottom, forceStickToBottom, scheduleStickToBottom, viewportRef]);

  const contentContainerStyle = useMemo((): CSSProperties => {
    return {
      display: "flex",
      flexDirection: "column",
      minHeight: "100%",
      paddingTop: 16,
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
  const viewportChromeStyle = useMemo(
    (): CSSProperties => ({
      position: "relative",
      display: "flex",
      flex: 1,
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
      transform: `translateY(${start}px)`,
    }),
    [],
  );
  const mountedHistoryRows = useMemo(() => {
    return segments.historyMounted.map((item, index) => (
      <div
        key={item.id}
        data-stream-item-id={item.id}
        data-stream-item-kind={item.kind}
        style={streamItemAnchorStyle}
      >
        {renderHistoryMountedRow(item, index, segments.historyMounted)}
      </div>
    ));
  }, [renderHistoryMountedRow, segments.historyMounted]);
  const liveHeadRows = useMemo(() => {
    return segments.liveHead.map((item, index) => (
      <div
        key={item.id}
        data-stream-item-id={item.id}
        data-stream-item-kind={item.kind}
        style={streamItemAnchorStyle}
      >
        {renderLiveHeadRow(item, index, segments.liveHead)}
      </div>
    ));
  }, [renderLiveHeadRow, segments.liveHead]);
  const liveAuxiliary = useMemo(() => {
    return renderLiveAuxiliary();
  }, [renderLiveAuxiliary]);
  const historyStartSlot = useMemo(() => {
    if (!isLoadingOlderHistory) {
      return null;
    }
    return (
      <div style={historyStartSlotStyle} data-testid="load-older-history-spinner">
        <ActivityIndicator size="small" />
      </div>
    );
  }, [isLoadingOlderHistory]);
  const shouldRenderEmpty =
    !boundary.hasMountedHistory &&
    !boundary.hasVirtualizedHistory &&
    !boundary.hasLiveHead &&
    !liveAuxiliary;
  const promptMarkers = useMemo((): PromptMarker[] => {
    return promptMarkerDescriptors.flatMap((marker) => {
      const targetOffset = promptRailMetrics.offsetsById.get(marker.id);
      return targetOffset === undefined ? [] : [{ ...marker, targetOffset }];
    });
  }, [promptMarkerDescriptors, promptRailMetrics.offsetsById]);
  const handlePromptMarkerPress = useCallback(
    (marker: PromptMarker) => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      const resolvedOffset = resolvePromptOffset(marker) ?? marker.targetOffset;
      const maxScrollOffset = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      );
      scrollContainer.scrollTo({
        top: clamp(resolvedOffset - PROMPT_SCROLL_TARGET_TOP_PADDING, 0, maxScrollOffset),
        behavior: "auto",
      });
    },
    [resolvePromptOffset],
  );

  return (
    <div style={viewportChromeStyle}>
      <div
        ref={handleScrollContainerRef}
        data-testid="agent-chat-scroll"
        id={`agent-chat-scroll-${shouldUseVirtualizer ? "web-dom-virtualized" : "web-dom-scroll"}`}
        style={scrollContainerStyle}
      >
        <div ref={handleContentRef} style={contentContainerStyle}>
          {historyStartSlot}
          {shouldUseVirtualizer ? (
            <div ref={virtualRowsContainerRef} style={virtualRowsContainerStyle}>
              {virtualRows.map((virtualRow) => {
                const item = segments.historyVirtualized[virtualRow.index];
                if (!item) {
                  return null;
                }
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    data-stream-item-id={item.id}
                    data-stream-item-kind={item.kind}
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
          {mountedHistoryRows}
          {liveHeadRows}
          {liveAuxiliary}
          {shouldRenderEmpty ? listEmptyComponent : null}
        </div>
      </div>
      <PromptMarkerRail
        markers={promptMarkers}
        viewportSize={promptRailMetrics.viewportSize}
        contentSize={promptRailMetrics.contentSize}
        onMarkerPress={handlePromptMarkerPress}
      />
      {scrollbarOverlay}
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

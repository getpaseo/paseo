import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  computeScrollOffsetFromDragDelta,
  computeVerticalScrollbarGeometry,
} from "./web-desktop-scrollbar.math";

const METRICS_EPSILON = 0.5;
const HANDLE_WIDTH_IDLE = 6;
const HANDLE_WIDTH_ACTIVE = 9;
const HANDLE_GRAB_WIDTH = 18;
const HANDLE_GRAB_VERTICAL_PADDING = 8;
const HANDLE_OPACITY_VISIBLE = 0.62;
const HANDLE_OPACITY_HOVERED = 0.78;
const HANDLE_OPACITY_DRAGGING = 0.9;
const HANDLE_TRAVEL_TRANSITION_DURATION_MS = 90;
const HANDLE_FADE_DURATION_MS = 220;
const HANDLE_WIDTH_TRANSITION_DURATION_MS = 240;
const HANDLE_SCROLL_VISIBILITY_MS = 1200;
const HANDLE_SCROLL_ACTIVE_MS = 110;

function readClientY(event: any): number | null {
  const value =
    event?.nativeEvent?.clientY ?? event?.clientY ?? event?.nativeEvent?.pageY ?? event?.pageY;
  return typeof value === "number" ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type ScrollbarMetrics = {
  offset: number;
  viewportSize: number;
  contentSize: number;
};

function areMetricsEqual(a: ScrollbarMetrics, b: ScrollbarMetrics): boolean {
  return (
    Math.abs(a.offset - b.offset) <= METRICS_EPSILON &&
    Math.abs(a.viewportSize - b.viewportSize) <= METRICS_EPSILON &&
    Math.abs(a.contentSize - b.contentSize) <= METRICS_EPSILON
  );
}

export function useWebDesktopScrollbarMetrics() {
  const [metrics, setMetrics] = useState<ScrollbarMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });

  const setMetricsIfChanged = useCallback((next: ScrollbarMetrics) => {
    setMetrics((previous) => (areMetricsEqual(previous, next) ? previous : next));
  }, []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      setMetricsIfChanged({
        offset: Math.max(0, contentOffset.y),
        viewportSize: Math.max(0, layoutMeasurement.height),
        contentSize: Math.max(0, contentSize.height),
      });
    },
    [setMetricsIfChanged],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportSize = Math.max(0, event.nativeEvent.layout.height);
    setMetrics((previous) => {
      const next = { ...previous, viewportSize };
      return areMetricsEqual(previous, next) ? previous : next;
    });
  }, []);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const contentSize = Math.max(0, height);
    setMetrics((previous) => {
      const next = { ...previous, contentSize };
      return areMetricsEqual(previous, next) ? previous : next;
    });
  }, []);

  const setOffset = useCallback((offset: number) => {
    const clampedOffset = Math.max(0, offset);
    setMetrics((previous) => {
      const next = { ...previous, offset: clampedOffset };
      return areMetricsEqual(previous, next) ? previous : next;
    });
  }, []);

  return {
    ...metrics,
    onScroll,
    onLayout,
    onContentSizeChange,
    setOffset,
  };
}

type WebDesktopScrollbarOverlayProps = {
  enabled: boolean;
  metrics: ScrollbarMetrics;
  onScrollToOffset: (offset: number) => void;
  inverted?: boolean;
};

export function WebDesktopScrollbarOverlay({
  enabled,
  metrics,
  onScrollToOffset,
  inverted = false,
}: WebDesktopScrollbarOverlayProps) {
  const { theme } = useUnistyles();
  const [isHandleHovered, setIsHandleHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isScrollVisible, setIsScrollVisible] = useState(false);
  const [isScrollActive, setIsScrollActive] = useState(false);
  const dragStartOffsetRef = useRef(0);
  const dragStartClientYRef = useRef(0);
  const scrollVisibilityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollActiveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastObservedOffsetRef = useRef<number | null>(null);
  const geometryRef = useRef({
    maxHandleOffset: 0,
    maxScrollOffset: 0,
  });
  const onScrollToOffsetRef = useRef(onScrollToOffset);
  const isWeb = Platform.OS === "web";

  const maxScrollOffset = Math.max(0, metrics.contentSize - metrics.viewportSize);
  const normalizedOffset = inverted
    ? Math.max(0, maxScrollOffset - clamp(metrics.offset, 0, maxScrollOffset))
    : clamp(metrics.offset, 0, maxScrollOffset);
  const normalizedOffsetRef = useRef(normalizedOffset);

  const geometry = useMemo(
    () =>
      computeVerticalScrollbarGeometry({
        viewportSize: metrics.viewportSize,
        contentSize: metrics.contentSize,
        offset: normalizedOffset,
      }),
    [metrics.contentSize, metrics.viewportSize, normalizedOffset],
  );

  useEffect(() => {
    geometryRef.current = {
      maxHandleOffset: geometry.maxHandleOffset,
      maxScrollOffset: geometry.maxScrollOffset,
    };
  }, [geometry.maxHandleOffset, geometry.maxScrollOffset]);

  useEffect(() => {
    onScrollToOffsetRef.current = onScrollToOffset;
  }, [onScrollToOffset]);

  useEffect(() => {
    normalizedOffsetRef.current = normalizedOffset;
  }, [normalizedOffset]);

  const clearScrollVisibilityTimeout = useCallback(() => {
    if (scrollVisibilityTimeoutRef.current === null) {
      return;
    }
    clearTimeout(scrollVisibilityTimeoutRef.current);
    scrollVisibilityTimeoutRef.current = null;
  }, []);

  const clearScrollActiveTimeout = useCallback(() => {
    if (scrollActiveTimeoutRef.current === null) {
      return;
    }
    clearTimeout(scrollActiveTimeoutRef.current);
    scrollActiveTimeoutRef.current = null;
  }, []);

  const revealScrollbarFromScroll = useCallback(() => {
    setIsScrollVisible(true);
    clearScrollVisibilityTimeout();
    scrollVisibilityTimeoutRef.current = setTimeout(() => {
      setIsScrollVisible(false);
      scrollVisibilityTimeoutRef.current = null;
    }, HANDLE_SCROLL_VISIBILITY_MS);
  }, [clearScrollVisibilityTimeout]);

  const markScrollActivity = useCallback(() => {
    setIsScrollActive(true);
    clearScrollActiveTimeout();
    scrollActiveTimeoutRef.current = setTimeout(() => {
      setIsScrollActive(false);
      scrollActiveTimeoutRef.current = null;
    }, HANDLE_SCROLL_ACTIVE_MS);
  }, [clearScrollActiveTimeout]);

  useEffect(() => {
    if (!enabled || !geometry.isVisible) {
      setIsScrollVisible(false);
      setIsScrollActive(false);
      clearScrollVisibilityTimeout();
      clearScrollActiveTimeout();
      lastObservedOffsetRef.current = null;
      return;
    }

    const previousOffset = lastObservedOffsetRef.current;
    lastObservedOffsetRef.current = normalizedOffset;
    if (previousOffset === null) {
      return;
    }
    if (Math.abs(normalizedOffset - previousOffset) <= METRICS_EPSILON) {
      return;
    }
    revealScrollbarFromScroll();
    markScrollActivity();
  }, [
    clearScrollActiveTimeout,
    clearScrollVisibilityTimeout,
    enabled,
    geometry.isVisible,
    markScrollActivity,
    normalizedOffset,
    revealScrollbarFromScroll,
  ]);

  useEffect(
    () => () => {
      clearScrollActiveTimeout();
      clearScrollVisibilityTimeout();
    },
    [clearScrollActiveTimeout, clearScrollVisibilityTimeout],
  );

  const applyDragDelta = useCallback(
    (dragDelta: number) => {
      const currentGeometry = geometryRef.current;
      const nextNormalizedOffset = computeScrollOffsetFromDragDelta({
        startOffset: dragStartOffsetRef.current,
        dragDelta,
        maxScrollOffset: currentGeometry.maxScrollOffset,
        maxHandleOffset: currentGeometry.maxHandleOffset,
      });
      const nextOffset = inverted
        ? currentGeometry.maxScrollOffset - nextNormalizedOffset
        : nextNormalizedOffset;
      onScrollToOffsetRef.current(nextOffset);
    },
    [inverted],
  );

  const panResponder = useMemo(() => {
    if (isWeb) {
      return null;
    }

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragStartOffsetRef.current = normalizedOffsetRef.current;
        setIsDragging(true);
      },
      onPanResponderMove: (_event, gestureState) => {
        applyDragDelta(gestureState.dy);
      },
      onPanResponderRelease: () => {
        setIsDragging(false);
      },
      onPanResponderTerminate: () => {
        setIsDragging(false);
      },
    });
  }, [applyDragDelta, isWeb]);

  const startWebDrag = useCallback(
    (event: any) => {
      if (!isWeb) {
        return;
      }
      const clientY = readClientY(event);
      if (clientY === null) {
        return;
      }
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.nativeEvent?.preventDefault?.();
      dragStartOffsetRef.current = normalizedOffsetRef.current;
      dragStartClientYRef.current = clientY;
      setIsDragging(true);
    },
    [isWeb],
  );

  const handleGrabHoverIn = useCallback(() => {
    if (!isScrollVisible && !isDragging) {
      return;
    }
    setIsHandleHovered(true);
  }, [isDragging, isScrollVisible]);

  const handleGrabHoverOut = useCallback(() => {
    setIsHandleHovered(false);
  }, []);

  useEffect(() => {
    if (!isWeb || !isDragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragDelta = event.clientY - dragStartClientYRef.current;
      applyDragDelta(dragDelta);
    };

    const stopDragging = () => {
      setIsDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [applyDragDelta, isDragging, isWeb]);

  if (!enabled || !geometry.isVisible) {
    return null;
  }

  const handleVisible = isDragging || isScrollVisible || isHandleHovered;
  const handleOpacity = isDragging
    ? HANDLE_OPACITY_DRAGGING
    : isHandleHovered
      ? HANDLE_OPACITY_HOVERED
      : isScrollVisible
        ? HANDLE_OPACITY_VISIBLE
        : 0;
  const handleWidth = isDragging || isHandleHovered ? HANDLE_WIDTH_ACTIVE : HANDLE_WIDTH_IDLE;
  const handleColor = theme.colors.scrollbarHandle;
  const handleCursor = isDragging ? "grabbing" : "grab";
  const handleTravelDurationMs =
    isDragging || isScrollActive ? 0 : HANDLE_TRAVEL_TRANSITION_DURATION_MS;
  const thumbRegionOffset = Math.max(0, geometry.handleOffset - HANDLE_GRAB_VERTICAL_PADDING);
  const thumbRegionHeight = Math.min(
    metrics.viewportSize - thumbRegionOffset,
    geometry.handleSize + HANDLE_GRAB_VERTICAL_PADDING * 2,
  );
  const handleInsetTop = Math.max(0, (thumbRegionHeight - geometry.handleSize) / 2);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <View
        style={[
          styles.thumbRegion,
          {
            top: 0,
            height: thumbRegionHeight,
            transform: [{ translateY: thumbRegionOffset }],
          },
          isWeb &&
            ({
              cursor: handleCursor,
              touchAction: "none",
              userSelect: "none",
              transitionProperty: "transform",
              transitionDuration: `${handleTravelDurationMs}ms`,
              transitionTimingFunction: "linear",
            } as any),
        ]}
        pointerEvents={handleVisible ? "auto" : "none"}
        {...(panResponder?.panHandlers ?? {})}
        {...(isWeb
          ? ({
              onPointerDown: startWebDrag,
              onPointerEnter: handleGrabHoverIn,
              onPointerLeave: handleGrabHoverOut,
              onMouseEnter: handleGrabHoverIn,
              onMouseLeave: handleGrabHoverOut,
            } as any)
          : null)}
      >
        <View
          style={[
            styles.handle,
            {
              marginTop: handleInsetTop,
              height: geometry.handleSize,
              width: handleWidth,
              backgroundColor: handleColor,
              opacity: handleOpacity,
            },
            isWeb &&
              ({
                transitionProperty: "opacity, width, background-color",
                transitionDuration: `${HANDLE_FADE_DURATION_MS}ms, ${HANDLE_WIDTH_TRANSITION_DURATION_MS}ms, ${HANDLE_FADE_DURATION_MS}ms`,
                transitionTimingFunction: "ease-out, cubic-bezier(0.22, 0.75, 0.2, 1), ease-out",
              } as any),
          ]}
          pointerEvents="none"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 12,
    alignItems: "center",
    justifyContent: "flex-start",
    zIndex: 10,
  },
  handle: {
    width: HANDLE_WIDTH_IDLE,
    borderRadius: 999,
    alignSelf: "center",
  },
  thumbRegion: {
    position: "absolute",
    right: -3,
    width: HANDLE_GRAB_WIDTH,
  },
}));

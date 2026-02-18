import { useCallback, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  Pressable,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type ScrollbarMetrics = {
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
    [setMetricsIfChanged]
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const viewportSize = Math.max(0, event.nativeEvent.layout.height);
      setMetrics((previous) => {
        const next = { ...previous, viewportSize };
        return areMetricsEqual(previous, next) ? previous : next;
      });
    },
    []
  );

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
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartOffsetRef = useRef(0);

  const maxScrollOffset = Math.max(0, metrics.contentSize - metrics.viewportSize);
  const normalizedOffset = inverted
    ? Math.max(0, maxScrollOffset - clamp(metrics.offset, 0, maxScrollOffset))
    : clamp(metrics.offset, 0, maxScrollOffset);

  const geometry = useMemo(
    () =>
      computeVerticalScrollbarGeometry({
        viewportSize: metrics.viewportSize,
        contentSize: metrics.contentSize,
        offset: normalizedOffset,
      }),
    [metrics.contentSize, metrics.viewportSize, normalizedOffset]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartOffsetRef.current = normalizedOffset;
          setIsDragging(true);
        },
        onPanResponderMove: (_event, gestureState) => {
          const nextNormalizedOffset = computeScrollOffsetFromDragDelta({
            startOffset: dragStartOffsetRef.current,
            dragDelta: gestureState.dy,
            maxScrollOffset: geometry.maxScrollOffset,
            maxHandleOffset: geometry.maxHandleOffset,
          });
          const nextOffset = inverted
            ? geometry.maxScrollOffset - nextNormalizedOffset
            : nextNormalizedOffset;
          onScrollToOffset(nextOffset);
        },
        onPanResponderRelease: () => {
          setIsDragging(false);
        },
        onPanResponderTerminate: () => {
          setIsDragging(false);
        },
      }),
    [
      geometry.maxHandleOffset,
      geometry.maxScrollOffset,
      inverted,
      normalizedOffset,
      onScrollToOffset,
    ]
  );

  if (!enabled || !geometry.isVisible) {
    return null;
  }

  const handleOpacity = isDragging ? 0.52 : isHovered ? 0.4 : 0.28;
  const handleColor =
    isDragging || isHovered
      ? theme.colors.foreground
      : theme.colors.foregroundMuted;

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Pressable
        style={[
          styles.handle,
          {
            top: geometry.handleOffset,
            height: geometry.handleSize,
            backgroundColor: handleColor,
            opacity: handleOpacity,
          },
          Platform.OS === "web" &&
            ({ cursor: "grab", touchAction: "none", userSelect: "none" } as any),
        ]}
        onHoverIn={() => setIsHovered(true)}
        onHoverOut={() => setIsHovered(false)}
        {...panResponder.panHandlers}
      />
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
    position: "absolute",
    width: 6,
    borderRadius: 999,
  },
}));

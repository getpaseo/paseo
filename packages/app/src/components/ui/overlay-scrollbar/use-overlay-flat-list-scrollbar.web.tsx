import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  FlatList,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WEB_SCROLLBAR_SIZE_PX } from "@/styles/web-scrollbar";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { computeOverlayScrollbarGeometry, scrollOffsetFromThumbDrag } from "./geometry";
import type { OverlayFlatListScrollbar } from "./use-overlay-flat-list-scrollbar";

const THUMB_WIDTH = WEB_SCROLLBAR_SIZE_PX - 4;
const THUMB_OPACITY = 0.62;
const GRAB_WIDTH = 12;

interface ScrollbarMetrics {
  offset: number;
  viewportSize: number;
  contentSize: number;
}

interface PointerLikeEvent {
  clientY?: number;
  nativeEvent?: { clientY?: number; preventDefault?: () => void };
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

function readClientY(event: PointerLikeEvent): number | null {
  const value = event.nativeEvent?.clientY ?? event.clientY;
  return typeof value === "number" ? value : null;
}

function OverlayScrollbar({
  listRef,
  metrics,
}: {
  listRef: RefObject<FlatList<unknown> | null>;
  metrics: ScrollbarMetrics;
}) {
  const geometry = useMemo(() => computeOverlayScrollbarGeometry(metrics), [metrics]);
  const geometryRef = useRef(geometry);
  const dragStartClientYRef = useRef(0);
  const dragStartOffsetRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);

  const scrollFromDrag = useCallback(
    (dragDelta: number) => {
      const current = geometryRef.current;
      listRef.current?.scrollToOffset({
        offset: scrollOffsetFromThumbDrag({
          startOffset: dragStartOffsetRef.current,
          dragDelta,
          maxScrollOffset: current.maxScrollOffset,
          maxThumbOffset: current.maxThumbOffset,
        }),
        animated: false,
      });
    },
    [listRef],
  );

  const startDrag = useCallback(
    (event: PointerLikeEvent) => {
      const clientY = readClientY(event);
      if (clientY === null) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      event.nativeEvent?.preventDefault?.();
      dragStartClientYRef.current = clientY;
      dragStartOffsetRef.current = metrics.offset;
      setIsDragging(true);
    },
    [metrics.offset],
  );

  useEffect(() => {
    if (!isDragging) return;
    const handlePointerMove = (event: PointerEvent) => {
      scrollFromDrag(event.clientY - dragStartClientYRef.current);
    };
    const stopDragging = () => setIsDragging(false);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [isDragging, scrollFromDrag]);

  const thumbRegionStyle = useMemo(
    () => [
      styles.thumbRegion,
      inlineUnistylesStyle({
        height: geometry.thumbSize,
        transform: [{ translateY: geometry.thumbOffset }],
        cursor: isDragging ? "grabbing" : "grab",
      } as unknown as ViewStyle),
    ],
    [geometry.thumbOffset, geometry.thumbSize, isDragging],
  );

  if (!geometry.isVisible) return null;

  return (
    <View style={styles.overlay} pointerEvents="box-none" testID="workspace-overlay-scrollbar">
      <View
        style={thumbRegionStyle}
        {...({ onPointerDown: startDrag } as object)}
        testID="workspace-overlay-scrollbar-grab"
      >
        <View
          style={styles.thumb}
          pointerEvents="none"
          testID="workspace-overlay-scrollbar-thumb"
        />
      </View>
    </View>
  );
}

export function useOverlayFlatListScrollbar<ItemT>(
  listRef: RefObject<FlatList<ItemT> | null>,
  options: { enabled: boolean },
): OverlayFlatListScrollbar {
  const [metrics, setMetrics] = useState<ScrollbarMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setMetrics((previous) => ({
      ...previous,
      offset: Math.max(0, event.nativeEvent.contentOffset.y),
      viewportSize: Math.max(0, event.nativeEvent.layoutMeasurement.height),
      contentSize: Math.max(0, event.nativeEvent.contentSize.height),
    }));
  }, []);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setMetrics((previous) => ({
      ...previous,
      viewportSize: Math.max(0, event.nativeEvent.layout.height),
    }));
  }, []);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    setMetrics((previous) => ({ ...previous, contentSize: Math.max(0, height) }));
  }, []);

  return {
    enabled: options.enabled,
    onContentSizeChange,
    onLayout,
    onScroll,
    overlay: options.enabled ? (
      <OverlayScrollbar
        listRef={listRef as RefObject<FlatList<unknown> | null>}
        metrics={metrics}
      />
    ) : null,
  };
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: WEB_SCROLLBAR_SIZE_PX,
    zIndex: 10,
  },
  thumbRegion: {
    position: "absolute",
    top: 0,
    right: -(GRAB_WIDTH - WEB_SCROLLBAR_SIZE_PX) / 2,
    width: GRAB_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    touchAction: "none",
    userSelect: "none",
  },
  thumb: {
    width: THUMB_WIDTH,
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.scrollbarHandle,
    opacity: THUMB_OPACITY,
  },
}));

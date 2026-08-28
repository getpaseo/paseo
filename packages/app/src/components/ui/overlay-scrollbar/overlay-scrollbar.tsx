import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WEB_SCROLLBAR_RESTING_OPACITY, WEB_SCROLLBAR_SIZE_PX } from "@/styles/web-scrollbar";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { computeOverlayScrollbarGeometry, scrollOffsetFromThumbDrag } from "./geometry";

const THUMB_WIDTH = WEB_SCROLLBAR_SIZE_PX - 4;
const GRAB_WIDTH = 12;

export interface OverlayScrollbarMetrics {
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

export function OverlayScrollbar({
  metrics,
  onScrollToOffset,
  onUserScrollUp,
}: {
  metrics: OverlayScrollbarMetrics;
  onScrollToOffset: (offset: number) => void;
  onUserScrollUp?: () => void;
}) {
  const geometry = useMemo(() => computeOverlayScrollbarGeometry(metrics), [metrics]);
  const geometryRef = useRef(geometry);
  const dragStartClientYRef = useRef(0);
  const dragStartOffsetRef = useRef(0);
  const lastRequestedOffsetRef = useRef(0);
  const reportedUpwardIntentRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);

  const startDrag = useCallback(
    (event: PointerLikeEvent) => {
      const clientY = readClientY(event);
      if (clientY === null) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      event.nativeEvent?.preventDefault?.();
      dragStartClientYRef.current = clientY;
      dragStartOffsetRef.current = metrics.offset;
      lastRequestedOffsetRef.current = metrics.offset;
      reportedUpwardIntentRef.current = false;
      setIsDragging(true);
    },
    [metrics.offset],
  );

  useEffect(() => {
    if (!isDragging) return;
    const handlePointerMove = (event: PointerEvent) => {
      const current = geometryRef.current;
      const nextOffset = scrollOffsetFromThumbDrag({
        startOffset: dragStartOffsetRef.current,
        dragDelta: event.clientY - dragStartClientYRef.current,
        maxScrollOffset: current.maxScrollOffset,
        maxThumbOffset: current.maxThumbOffset,
      });
      if (nextOffset < lastRequestedOffsetRef.current && !reportedUpwardIntentRef.current) {
        reportedUpwardIntentRef.current = true;
        onUserScrollUp?.();
      }
      lastRequestedOffsetRef.current = nextOffset;
      onScrollToOffset(nextOffset);
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
  }, [isDragging, onScrollToOffset, onUserScrollUp]);

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
      <Pressable
        style={thumbRegionStyle}
        {...({ onPointerDown: startDrag } as object)}
        testID="workspace-overlay-scrollbar-grab"
      >
        {({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => (
          <View
            style={[styles.thumb, hovered || isDragging ? styles.thumbHovered : null]}
            pointerEvents="none"
            testID="workspace-overlay-scrollbar-thumb"
          />
        )}
      </Pressable>
    </View>
  );
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
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: WEB_SCROLLBAR_RESTING_OPACITY,
  },
  thumbHovered: {
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 1,
  },
}));

import { useCallback, useMemo, useRef, useState } from "react";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { startResizeHandleDrag, type ResizeHandleDrag } from "@/components/resize-handle-drag";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";

export interface ResizeHandleProps {
  testID?: string;
  direction: "horizontal" | "vertical";
  hitAreaAlignment?: "center" | "end";
  groupId: string;
  index: number;
  sizes: number[];
  containerSize: number;
  onPreviewResizeSplit: (groupId: string, sizes: number[]) => void;
  onResizeSplit: (groupId: string, sizes: number[]) => void;
}

interface PointerState {
  containerSize: number;
  pointerStart: number;
  drag: ResizeHandleDrag;
}

function resetWindowHorizontalScroll() {
  // Clamp any browser scroll introduced while dragging past the viewport edge.
  if (window.scrollX === 0) {
    return;
  }
  window.scrollTo(0, window.scrollY);
}

export function ResizeHandle({
  testID,
  direction,
  hitAreaAlignment = "center",
  groupId,
  index,
  sizes,
  containerSize,
  onPreviewResizeSplit,
  onResizeSplit,
}: ResizeHandleProps) {
  const { theme } = useUnistyles();
  const finePointer = useHasFinePointer();
  const pointerStatesRef = useRef(new Map<number, PointerState>());
  const touchDragRef = useRef<ResizeHandleDrag | null>(null);
  const cursorBeforeDragRef = useRef<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const highlighted = active || dragging;

  const handlePointerDown = useCallback(
    (event: RNPointerEvent) => {
      const hitAreaElement = event.currentTarget as unknown as HTMLElement | null;
      if (!hitAreaElement) {
        return;
      }

      if (containerSize <= 0) {
        return;
      }

      const pointerId = event.nativeEvent.pointerId;
      if (pointerStatesRef.current.has(pointerId)) {
        return;
      }

      setDragging(true);

      pointerStatesRef.current.set(pointerId, {
        containerSize,
        pointerStart:
          direction === "horizontal" ? event.nativeEvent.clientX : event.nativeEvent.clientY,
        drag: startResizeHandleDrag({
          sizes,
          index,
          preview: (nextSizes) => onPreviewResizeSplit(groupId, nextSizes),
          commit: (nextSizes) => onResizeSplit(groupId, nextSizes),
        }),
      });

      if (pointerStatesRef.current.size === 1) {
        cursorBeforeDragRef.current = document.body.style.cursor;
      }
      const nextCursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.cursor = nextCursor;
      event.preventDefault();
      event.stopPropagation();
      const pointerCaptureElement = hitAreaElement;
      pointerCaptureElement.setPointerCapture?.(pointerId);
      resetWindowHorizontalScroll();

      function cleanup() {
        pointerStatesRef.current.delete(pointerId);
        setDragging(pointerStatesRef.current.size > 0);
        if (pointerStatesRef.current.size === 0) {
          document.body.style.cursor = cursorBeforeDragRef.current ?? "";
          cursorBeforeDragRef.current = null;
        }
        if (pointerCaptureElement.hasPointerCapture?.(pointerId)) {
          pointerCaptureElement.releasePointerCapture(pointerId);
        }
        resetWindowHorizontalScroll();
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      }

      function handlePointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }

        const pointerState = pointerStatesRef.current.get(pointerId);
        if (!pointerState) {
          return;
        }

        moveEvent.preventDefault();
        resetWindowHorizontalScroll();
        const pointerCurrent = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const deltaRatio =
          (pointerCurrent - pointerState.pointerStart) / pointerState.containerSize;

        pointerState.drag.move(deltaRatio);
      }

      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) {
          return;
        }

        pointerStatesRef.current.get(pointerId)?.drag.finish();
        cleanup();
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [containerSize, direction, groupId, index, onPreviewResizeSplit, onResizeSplit, sizes],
  );

  const touchGesture = useMemo(() => {
    const gesture = Gesture.Pan()
      .runOnJS(true)
      .onBegin(() => setDragging(true))
      .onStart(() => {
        touchDragRef.current = startResizeHandleDrag({
          sizes,
          index,
          preview: (nextSizes) => onPreviewResizeSplit(groupId, nextSizes),
          commit: (nextSizes) => onResizeSplit(groupId, nextSizes),
        });
      })
      .onUpdate((event) => {
        if (containerSize <= 0) return;
        const translation = direction === "horizontal" ? event.translationX : event.translationY;
        touchDragRef.current?.move(translation / containerSize);
      })
      .onEnd(() => touchDragRef.current?.finish())
      .onFinalize(() => {
        touchDragRef.current = null;
        setDragging(false);
      });

    return direction === "horizontal"
      ? gesture
          .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
          .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
      : gesture
          .activeOffsetY([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
          .failOffsetX([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET]);
  }, [containerSize, direction, groupId, index, onPreviewResizeSplit, onResizeSplit, sizes]);

  const handlePointerEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => {
      setActive(true);
    }, 150);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setActive(false);
  }, []);

  const handleStyle = useMemo(
    () => [
      styles.handle,
      direction === "horizontal" ? styles.handleHorizontal : styles.handleVertical,
      { backgroundColor: theme.colors.border },
    ],
    [direction, theme.colors.border],
  );
  const highlightStyle = useMemo(
    () => [
      styles.highlight,
      direction === "horizontal" ? styles.highlightHorizontal : styles.highlightVertical,
      { backgroundColor: theme.colors.accent },
    ],
    [direction, theme.colors.accent],
  );
  const hitAreaStyle = useMemo(
    () => [
      styles.hitArea,
      direction === "horizontal" ? styles.hitAreaHorizontal : styles.hitAreaVertical,
      {
        ...(direction === "horizontal"
          ? { left: hitAreaAlignment === "end" ? 0 : -5 }
          : { top: hitAreaAlignment === "end" ? 0 : -5 }),
        cursor: direction === "horizontal" ? "col-resize" : "row-resize",
        touchAction: "none",
      } as object,
    ],
    [direction, hitAreaAlignment],
  );
  const touchHitAreaStyle = useMemo(
    () => [
      styles.touchHitArea,
      direction === "horizontal" ? styles.touchHitAreaHorizontal : styles.touchHitAreaVertical,
      {
        ...(direction === "horizontal"
          ? { left: hitAreaAlignment === "end" ? 0 : -12 }
          : { top: hitAreaAlignment === "end" ? 0 : -12 }),
        touchAction: "none",
      } as object,
    ],
    [direction, hitAreaAlignment],
  );
  const touchGripStyle = useMemo(
    () => [
      styles.touchGrip,
      direction === "horizontal" ? styles.touchGripHorizontal : styles.touchGripVertical,
      highlighted ? styles.touchGripVisible : styles.touchGripHidden,
      { backgroundColor: theme.colors.foreground },
    ],
    [direction, highlighted, theme.colors.foreground],
  );

  return (
    <View style={handleStyle} testID={testID}>
      {highlighted && (
        <View
          pointerEvents="none"
          style={highlightStyle}
          testID={testID ? `${testID}-highlight` : undefined}
        />
      )}
      {finePointer ? (
        <View
          role="separator"
          aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
          style={hitAreaStyle}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        />
      ) : (
        <GestureDetector gesture={touchGesture}>
          <View
            role="separator"
            aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
            collapsable={false}
            style={touchHitAreaStyle}
          >
            <View pointerEvents="none" style={touchGripStyle} />
          </View>
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create((_theme) => ({
  handle: {
    position: "relative",
    flexShrink: 0,
    zIndex: 10,
  },
  handleHorizontal: {
    width: 1,
    alignSelf: "stretch",
  },
  handleVertical: {
    height: 1,
    width: "100%",
  },
  highlight: {
    position: "absolute",
    zIndex: 5,
  },
  highlightHorizontal: {
    top: 0,
    bottom: 0,
    width: 3,
    left: -1,
  },
  highlightVertical: {
    left: 0,
    right: 0,
    height: 3,
    top: -1,
  },
  hitArea: {
    position: "absolute",
    zIndex: 10,
  },
  hitAreaHorizontal: {
    top: 0,
    bottom: 0,
    width: 10,
  },
  hitAreaVertical: {
    left: 0,
    right: 0,
    height: 10,
  },
  touchHitArea: {
    position: "absolute",
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  touchHitAreaHorizontal: {
    top: "50%",
    width: 24,
    height: 88,
    transform: [{ translateY: -44 }],
  },
  touchHitAreaVertical: {
    left: "50%",
    width: 88,
    height: 24,
    transform: [{ translateX: -44 }],
  },
  touchGrip: {
    borderRadius: 2,
  },
  touchGripHorizontal: {
    width: 4,
    height: 36,
  },
  touchGripVertical: {
    width: 36,
    height: 4,
  },
  touchGripHidden: {
    opacity: 0.12,
  },
  touchGripVisible: {
    opacity: 0.3,
  },
}));

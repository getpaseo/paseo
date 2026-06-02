import { useCallback, useMemo, useRef, useState } from "react";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { computeResizeHandleSizes } from "@/components/resize-handle-sizes";

export interface ResizeHandleProps {
  direction: "horizontal" | "vertical";
  groupId: string;
  index: number;
  sizes: number[];
  onResizeSplit: (groupId: string, sizes: number[]) => void;
}

interface PointerState {
  containerSize: number;
  pointerStart: number;
}

function resetWindowHorizontalScroll() {
  // Clamp any browser scroll introduced while dragging past the viewport edge.
  if (window.scrollX === 0) {
    return;
  }
  window.scrollTo(0, window.scrollY);
}

export function ResizeHandle({
  direction,
  groupId,
  index,
  sizes,
  onResizeSplit,
}: ResizeHandleProps) {
  const { theme } = useUnistyles();
  const pointerStatesRef = useRef(new Map<number, PointerState>());
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

      const containerElement = hitAreaElement.parentElement?.parentElement ?? null;
      if (!containerElement) {
        return;
      }

      const rect = containerElement.getBoundingClientRect();
      const containerSize = direction === "horizontal" ? rect.width : rect.height;
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

        onResizeSplit(
          groupId,
          computeResizeHandleSizes({
            sizes,
            index,
            deltaRatio,
          }),
        );
      }

      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) {
          return;
        }

        cleanup();
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [direction, groupId, index, onResizeSplit, sizes],
  );

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
        cursor: direction === "horizontal" ? "col-resize" : "row-resize",
        touchAction: "none",
      } as object,
    ],
    [direction],
  );

  return (
    <View style={handleStyle}>
      {highlighted && <View pointerEvents="none" style={highlightStyle} />}
      <View
        role="separator"
        aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
        style={hitAreaStyle}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      />
    </View>
  );
}

const styles = StyleSheet.create((_theme) => ({
  handle: {
    position: "relative",
    flexShrink: 0,
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
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
  },
  hitAreaVertical: {
    top: -5,
    left: 0,
    right: 0,
    height: 10,
  },
}));

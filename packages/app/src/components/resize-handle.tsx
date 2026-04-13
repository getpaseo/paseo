import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

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
  leftSize: number;
  rightSize: number;
}

export function ResizeHandle({
  direction,
  groupId,
  index,
  sizes,
  onResizeSplit,
}: ResizeHandleProps) {
  const { theme } = useUnistyles();
  const pointerStateRef = useRef<PointerState | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const highlighted = active || dragging;

  const handlePointerDown = useCallback(
    (event: any) => {
      const hitAreaElement = event.currentTarget as HTMLElement | null;
      const containerElement = hitAreaElement?.parentElement?.parentElement ?? null;
      if (!containerElement) {
        return;
      }

      const rect = containerElement.getBoundingClientRect();
      const containerSize = direction === "horizontal" ? rect.width : rect.height;
      if (containerSize <= 0) {
        return;
      }

      setDragging(true);

      pointerStateRef.current = {
        containerSize,
        pointerStart: direction === "horizontal" ? event.clientX : event.clientY,
        leftSize: sizes[index] ?? 0,
        rightSize: sizes[index + 1] ?? 0,
      };

      const previousCursor = document.body.style.cursor;
      const nextCursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.cursor = nextCursor;
      event.preventDefault();

      function cleanup() {
        pointerStateRef.current = null;
        setDragging(false);
        document.body.style.cursor = previousCursor;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      }

      function handlePointerMove(moveEvent: PointerEvent) {
        const pointerState = pointerStateRef.current;
        if (!pointerState) {
          return;
        }

        const pointerCurrent = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const deltaRatio =
          (pointerCurrent - pointerState.pointerStart) / pointerState.containerSize;

        const nextSizes = sizes.slice();
        nextSizes[index] = pointerState.leftSize + deltaRatio;
        nextSizes[index + 1] = pointerState.rightSize - deltaRatio;
        onResizeSplit(groupId, nextSizes);
      }

      function handlePointerUp() {
        cleanup();
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [direction, groupId, index, onResizeSplit, sizes],
  );

  return (
    <View
      style={[
        styles.handle,
        direction === "horizontal" ? styles.handleHorizontal : styles.handleVertical,
        { backgroundColor: theme.colors.border },
      ]}
    >
      {highlighted && (
        <View
          pointerEvents="none"
          style={[
            styles.highlight,
            direction === "horizontal" ? styles.highlightHorizontal : styles.highlightVertical,
            { backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      <View
        role="separator"
        aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
        style={[
          styles.hitArea,
          direction === "horizontal" ? styles.hitAreaHorizontal : styles.hitAreaVertical,
          {
            cursor: direction === "horizontal" ? "col-resize" : "row-resize",
          } as any,
        ]}
        onPointerDown={handlePointerDown}
        onPointerEnter={() => {
          hoverTimerRef.current = setTimeout(() => {
            setActive(true);
          }, 150);
        }}
        onPointerLeave={() => {
          if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
          }
          setActive(false);
        }}
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

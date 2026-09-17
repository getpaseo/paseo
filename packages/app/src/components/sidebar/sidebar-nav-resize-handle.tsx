import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

interface SidebarNavResizeHandleProps {
  height: number;
  onPreviewHeight: (height: number) => void;
  onCommitHeight: (height: number) => void;
}

/**
 * The divider between the sidebar's navigation group and the workspace list.
 *
 * A fine pointer drives it with raw pointer events, as the pane splitter does: the
 * Gesture Handler pan that the sidebar's width handle uses drops a mouse drag that
 * leaves its 10px strip on the first move. Touch keeps the pan, which is the input it
 * was written for.
 */
export function SidebarNavResizeHandle({
  height,
  onPreviewHeight,
  onCommitHeight,
}: SidebarNavResizeHandleProps) {
  const { t } = useTranslation();
  const finePointer = useHasFinePointer();
  const startRef = useRef({ pointerY: 0, height: 0 });
  const pendingRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const label = t("sidebar.nav.resize");

  const handlePointerDown = useCallback(
    (event: RNPointerEvent) => {
      const target = event.currentTarget as unknown as HTMLElement | null;
      if (!target) return;

      const pointerId = event.nativeEvent.pointerId;
      startRef.current = { pointerY: event.nativeEvent.clientY, height };
      pendingRef.current = null;
      setDragging(true);
      event.preventDefault();
      event.stopPropagation();
      target.setPointerCapture?.(pointerId);

      function cleanup() {
        setDragging(false);
        if (target?.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      }

      function handlePointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const next = startRef.current.height + (moveEvent.clientY - startRef.current.pointerY);
        pendingRef.current = next;
        onPreviewHeight(next);
      }

      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        if (pendingRef.current !== null) {
          onCommitHeight(pendingRef.current);
          pendingRef.current = null;
        }
        cleanup();
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [height, onCommitHeight, onPreviewHeight],
  );

  const touchGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onBegin(() => {
          startRef.current = { pointerY: 0, height };
          setDragging(true);
        })
        .onUpdate((event) => {
          const next = startRef.current.height + event.translationY;
          pendingRef.current = next;
          onPreviewHeight(next);
        })
        .onEnd(() => {
          if (pendingRef.current !== null) {
            onCommitHeight(pendingRef.current);
            pendingRef.current = null;
          }
        })
        .onFinalize(() => setDragging(false)),
    [height, onCommitHeight, onPreviewHeight],
  );

  const hitAreaStyle = useMemo(
    () => [styles.hitArea, { cursor: "row-resize", touchAction: "none" } as object],
    [],
  );

  if (finePointer) {
    return (
      <View
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        testID="sidebar-nav-group-resize-handle"
        style={hitAreaStyle}
        onPointerDown={handlePointerDown}
      >
        {dragging ? <View pointerEvents="none" style={styles.activeLine} /> : null}
      </View>
    );
  }

  return (
    <GestureDetector gesture={touchGesture}>
      <View
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        collapsable={false}
        testID="sidebar-nav-group-resize-handle"
        style={styles.touchHitArea}
      >
        <View pointerEvents="none" style={dragging ? styles.visibleGrip : styles.grip} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Straddles the group's bottom border so the whole edge is the target.
  hitArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: -5,
    height: 10,
    zIndex: 10,
  },
  activeLine: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 4,
    height: 2,
    backgroundColor: theme.colors.accent,
  },
  touchHitArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: -12,
    height: 24,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  grip: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.foreground,
    opacity: 0.12,
  },
  visibleGrip: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.foreground,
    opacity: 0.3,
  },
}));

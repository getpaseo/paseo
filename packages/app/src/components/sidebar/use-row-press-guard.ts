import { useCallback, useMemo, useRef } from "react";
import type { GestureResponderEvent } from "react-native";
import { didPressMove } from "@/utils/sidebar-gesture-arbitration";

/**
 * Tracks a row press so a touch that scrolled, swiped, or drifted does not navigate when it is
 * released. Wire the handlers to the row's Pressable and ask `consumeMovedPress` in `onPress`.
 */
export function useRowPressGuard() {
  const movedRef = useRef(false);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    movedRef.current = false;
    startPointRef.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
  }, []);

  const handleTouchMove = useCallback((event: GestureResponderEvent) => {
    const startPoint = startPointRef.current;
    if (!startPoint || movedRef.current) {
      return;
    }
    const touch = event?.nativeEvent?.touches?.[0] ?? event?.nativeEvent;
    const x = touch?.pageX;
    const y = touch?.pageY;
    if (typeof x !== "number" || typeof y !== "number") {
      return;
    }
    movedRef.current = didPressMove({ startPoint, currentPoint: { x, y } });
  }, []);

  const handlePressOut = useCallback(() => {
    startPointRef.current = null;
  }, []);

  const consumeMovedPress = useCallback(() => {
    const moved = movedRef.current;
    movedRef.current = false;
    return moved;
  }, []);

  return useMemo(
    () => ({ handlePressIn, handleTouchMove, handlePressOut, consumeMovedPress }),
    [consumeMovedPress, handlePressIn, handlePressOut, handleTouchMove],
  );
}

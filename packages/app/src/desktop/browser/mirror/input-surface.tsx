import { useCallback, useRef } from "react";
import { View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BrowserMirrorInputSurfaceProps } from "./input-surface.types";
import { toGuestPoint } from "./viewport";

const SCROLL_GESTURE_THRESHOLD_PX = 6;

function toPanePoint(event: GestureResponderEvent): { x: number; y: number } {
  return { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
}

/**
 * Touch has no wheel and no hover, so a drag is a scroll and a tap is a click.
 */
export function BrowserMirrorInputSurface({
  fit,
  guest,
  isInteractive,
  onInput,
  onFocusKeyboard,
  onLayout,
  children,
}: BrowserMirrorInputSurfaceProps) {
  const gestureRef = useRef<{ x: number; y: number; scrolled: boolean } | null>(null);

  const handleResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      if (!fit) {
        return;
      }
      const point = toGuestPoint(toPanePoint(event), fit, guest);
      gestureRef.current = { ...point, scrolled: false };
    },
    [fit, guest],
  );

  const handleResponderMove = useCallback(
    (event: GestureResponderEvent) => {
      const origin = gestureRef.current;
      if (!fit || !origin) {
        return;
      }
      const point = toGuestPoint(toPanePoint(event), fit, guest);
      const deltaX = origin.x - point.x;
      const deltaY = origin.y - point.y;
      if (
        !origin.scrolled &&
        Math.abs(deltaX) < SCROLL_GESTURE_THRESHOLD_PX &&
        Math.abs(deltaY) < SCROLL_GESTURE_THRESHOLD_PX
      ) {
        return;
      }
      gestureRef.current = { x: point.x, y: point.y, scrolled: true };
      onInput({ kind: "wheel", x: point.x, y: point.y, deltaX, deltaY });
    },
    [fit, guest, onInput],
  );

  const handleResponderRelease = useCallback(
    (event: GestureResponderEvent) => {
      const origin = gestureRef.current;
      gestureRef.current = null;
      if (!fit || !origin || origin.scrolled) {
        return;
      }
      const point = toGuestPoint(toPanePoint(event), fit, guest);
      onInput({
        kind: "click",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        modifiers: [],
      });
      // Tapping the page is what arms typing, mirroring how a real click focuses it.
      onFocusKeyboard();
    },
    [fit, guest, onFocusKeyboard, onInput],
  );

  const shouldCaptureResponder = useCallback(
    () => isInteractive && fit !== null,
    [fit, isInteractive],
  );

  return (
    <View
      style={styles.container}
      onLayout={onLayout}
      onStartShouldSetResponder={shouldCaptureResponder}
      onMoveShouldSetResponder={shouldCaptureResponder}
      onResponderGrant={handleResponderGrant}
      onResponderMove={handleResponderMove}
      onResponderRelease={handleResponderRelease}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});

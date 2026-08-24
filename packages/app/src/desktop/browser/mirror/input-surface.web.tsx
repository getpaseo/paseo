import { useEffect, useRef } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BrowserMirrorInputSurfaceProps } from "./input-surface.types";
import { attachMouseInput, type MouseInputState } from "./mouse-input";

/**
 * Binds the pane's frame to a real mouse: the surface owns the element, the
 * mouse module owns the phases, the wheel, and the mapping into guest space.
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
  const containerRef = useRef<View>(null);
  const state = useRef<MouseInputState>({ fit, guest, isInteractive, onInput, onFocusKeyboard });
  useEffect(() => {
    state.current = { fit, guest, isInteractive, onInput, onFocusKeyboard };
  });

  // Listeners attach once and read the latest props through the ref: a drag
  // must survive the frame resizing under it.
  useEffect(() => {
    const element = containerRef.current as unknown as HTMLElement | null;
    if (!element) {
      return;
    }
    return attachMouseInput(element, state);
  }, []);

  return (
    <View ref={containerRef} style={styles.container} onLayout={onLayout}>
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

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import {
  PanResponder,
  // Plugin content owns visual feedback; this target adds only gestures and accessibility.
  // eslint-disable-next-line paseo/no-raw-pressable
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import type { PluginFloatingWidgetDragHandleProps } from "@getpaseo/plugin/client";
import { isWeb } from "@/constants/platform";

export interface FloatingWidgetDrag {
  begin(): void;
  move(dx: number, dy: number): void;
  end(): void;
}

export const FloatingWidgetDragContext = createContext<FloatingWidgetDrag | null>(null);
const DRAG_THRESHOLD = 6;

/** One pointer lifecycle for both host toolbar controls and plugin-provided handles. */
export function useFloatingWidgetDragTarget(
  drag: FloatingWidgetDrag,
  {
    onPress,
    onLongPress,
    delayLongPress = 450,
  }: Pick<PluginFloatingWidgetDragHandleProps, "onPress" | "onLongPress" | "delayLongPress">,
) {
  const currentDrag = useRef(drag);
  currentDrag.current = drag;
  const owner = useRef<FloatingWidgetDrag | null>(null);
  const callbacks = useRef({ onPress, onLongPress, delayLongPress });
  callbacks.current = { onPress, onLongPress, delayLongPress };
  const gesture = useRef({ active: false, moved: false, longPressed: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responder = useMemo(() => {
    const clearTimer = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const finish = () => {
      clearTimer();
      if (!gesture.current.active) return;
      gesture.current.active = false;
      owner.current?.end();
      owner.current = null;
    };
    const move = (dx: number, dy: number) => {
      if (!gesture.current.active) return;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        gesture.current.moved = true;
        clearTimer();
      }
      if (gesture.current.moved) owner.current?.move(dx, dy);
    };
    return {
      cancel: finish,
      ...PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        // RN Web accounts for moves over a child in capture and then skips its
        // onResponderMove duplicate. Process that path too, before the pointer
        // leaves the handle, so its long-press timer is cancelled promptly.
        onMoveShouldSetPanResponderCapture: (_event, state) => {
          move(state.dx, state.dy);
          return false;
        },
        onPanResponderGrant: () => {
          clearTimer();
          gesture.current = { active: true, moved: false, longPressed: false };
          owner.current = currentDrag.current;
          owner.current.begin();
          if (callbacks.current.onLongPress) {
            timer.current = setTimeout(() => {
              timer.current = null;
              if (!gesture.current.active || gesture.current.moved) return;
              gesture.current.longPressed = true;
              callbacks.current.onLongPress?.();
            }, callbacks.current.delayLongPress);
          }
        },
        onPanResponderMove: (_event, state) => move(state.dx, state.dy),
        onPanResponderRelease: (event, state) => {
          event.preventDefault();
          move(state.dx, state.dy);
          const press =
            gesture.current.active && !gesture.current.moved && !gesture.current.longPressed;
          finish();
          if (press) callbacks.current.onPress?.();
        },
        onPanResponderTerminate: finish,
        onPanResponderTerminationRequest: () => false,
      }),
    };
  }, []);
  // Keep PanResponder's internal interaction handle until its release/termination;
  // switching hosts cancels our gesture without replacing that active responder.
  useLayoutEffect(() => () => responder.cancel(), [drag, responder]);
  const activate = useCallback((event: GestureResponderEvent) => {
    // RN Web's View drops PanResponder's onClickCapture. Pointer release already
    // handled its tap, so ignore the browser's following click (detail > 0).
    // Keyboard and assistive activation have detail 0 and remain usable even
    // immediately after a pointer gesture. Native Pressability owns that path.
    if (isWeb && "detail" in event.nativeEvent && event.nativeEvent.detail !== 0) return;
    if (!gesture.current.active) callbacks.current.onPress?.();
  }, []);

  return { panHandlers: responder.panHandlers, activate };
}

/** Own the responder from pointer-down so a nested Pressable cannot steal the drag. */
export function FloatingWidgetDragHandle({
  children,
  style,
  testID,
  accessibilityLabel,
  accessibilityRole = "button",
  accessibilityHint,
  onPress,
  onLongPress,
  delayLongPress,
}: PluginFloatingWidgetDragHandleProps) {
  const drag = useContext(FloatingWidgetDragContext);
  if (!drag) throw new Error("Floating widget drag handles require their widget context");
  const { panHandlers, activate } = useFloatingWidgetDragTarget(drag, {
    onPress,
    onLongPress,
    delayLongPress,
  });

  return (
    <View style={style} testID={testID} {...panHandlers}>
      <Pressable
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onPress={activate}
        style={styles.target}
      >
        {children}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({ target: { flex: 1 } });

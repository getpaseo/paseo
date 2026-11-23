import { createContext, useContext, useMemo, type ReactElement } from "react";
import { Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

const IndependentScrollGestureContext = createContext<ReturnType<typeof Gesture.Native> | null>(
  null,
);

/** The native scroll gesture of the enclosing boundary, for gestures that must not cancel it. */
export function useIndependentScrollGesture(): ReturnType<typeof Gesture.Native> | null {
  return useContext(IndependentScrollGestureContext);
}

/**
 * Keeps a scroll view's touches on it instead of a parent pan: activating on the first move and
 * refusing interruption stops that pan from cancelling Android's native scroll, and keeps ACTION_UP
 * for the fling.
 *
 * A pressable inside has to join that gesture through `useIndependentScrollGesture`, or it never
 * receives a tap on Android.
 */
export function IndependentScrollBoundary({ children }: { children: ReactElement }) {
  const nativeScrollGesture = useMemo(
    () =>
      Gesture.Native()
        .shouldActivateOnStart(true)
        .shouldCancelWhenOutside(false)
        .disallowInterruption(true),
    [],
  );

  if (Platform.OS !== "android") {
    return children;
  }

  return (
    <IndependentScrollGestureContext.Provider value={nativeScrollGesture}>
      <GestureDetector gesture={nativeScrollGesture}>{children}</GestureDetector>
    </IndependentScrollGestureContext.Provider>
  );
}

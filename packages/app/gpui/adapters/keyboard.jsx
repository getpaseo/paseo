import { useEffect } from "react";
import { Keyboard, ScrollView, useAnimatedValue } from "react-native";
import { useSharedValue } from "react-native-reanimated";

// A GPUI desktop window has no software-keyboard inset. RN still owns focus
// and physical keyboard events; the mobile layout API observes its events.
export function KeyboardProvider({ children }) {
  return children;
}
export const KeyboardAwareScrollView = ScrollView;
export const KeyboardController = {
  isVisible: () => Keyboard.isVisible(),
  dismiss: () => Keyboard.dismiss(),
};
export const KeyboardEvents = { addListener: (...args) => Keyboard.addListener(...args) };
export function useReanimatedKeyboardAnimation() {
  const height = useSharedValue(0);
  const progress = useSharedValue(0);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (event) => {
      height.value = -event.endCoordinates.height;
      progress.value = 1;
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      height.value = 0;
      progress.value = 0;
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [height, progress]);
  return { height, progress };
}
export function useKeyboardAnimation() {
  const height = useAnimatedValue(0);
  const progress = useAnimatedValue(0);
  return { height, progress };
}
export function useGenericKeyboardHandler(handlers) {
  useEffect(() => {
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", (event) => {
        const value = {
          height: event.endCoordinates.height,
          progress: 1,
          duration: event.duration,
        };
        handlers.onStart?.(value);
        handlers.onEnd?.(value);
      }),
      Keyboard.addListener("keyboardDidHide", () => {
        const value = { height: 0, progress: 0, duration: 0 };
        handlers.onStart?.(value);
        handlers.onEnd?.(value);
      }),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [handlers]);
}

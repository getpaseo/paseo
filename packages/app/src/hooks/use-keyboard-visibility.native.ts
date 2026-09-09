import { useSyncExternalStore } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

const subscribe = (onStoreChange: () => void) => {
  const subscriptions = (["keyboardWillShow", "keyboardDidHide"] as const).map((event) =>
    KeyboardEvents.addListener(event, onStoreChange),
  );
  return () => {
    for (const subscription of subscriptions) {
      subscription.remove();
    }
  };
};

export function useKeyboardVisibility(enabled = true): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (enabled ? KeyboardController.isVisible() : false),
    () => false,
  );
}

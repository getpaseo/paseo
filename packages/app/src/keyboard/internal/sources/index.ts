import { AppState } from "react-native";
import type { KeyboardPolicyInput, KeyboardSourceHandlers } from "./contract";
import {
  setHardwareKeyboardClaimedShortcuts,
  setHardwareKeyboardOverlayKeys,
  subscribeHardwareKeyboard,
} from "./hardware";
import { createHardwareKeyboardSource } from "./native";
const hardwareKeyboard = createHardwareKeyboardSource({
  subscribe: subscribeHardwareKeyboard,
  subscribeBlur: (onBlur) => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        onBlur();
      }
    });
    return () => subscription.remove();
  },
  setOverlayKeys: setHardwareKeyboardOverlayKeys,
  setClaimedShortcuts: setHardwareKeyboardClaimedShortcuts,
});
export function attachKeyboardSources(handlers: KeyboardSourceHandlers): () => void {
  return hardwareKeyboard.attach(handlers);
}

export function publishKeyboardPolicy(input: KeyboardPolicyInput): void {
  hardwareKeyboard.publishPolicy(input);
}

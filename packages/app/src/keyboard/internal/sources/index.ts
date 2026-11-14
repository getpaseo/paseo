import type { KeyboardPolicyInput, KeyboardSourceHandlers } from "./contract";
import {
  setHardwareKeyboardClaimedShortcuts,
  setHardwareKeyboardOverlayKeys,
  subscribeHardwareKeyboard,
} from "./hardware";
import { createHardwareKeyboardSource } from "./native";
const hardwareKeyboard = createHardwareKeyboardSource({
  subscribe: subscribeHardwareKeyboard,
  setOverlayKeys: setHardwareKeyboardOverlayKeys,
  setClaimedShortcuts: setHardwareKeyboardClaimedShortcuts,
});
export function attachKeyboardSources(handlers: KeyboardSourceHandlers): () => void {
  return hardwareKeyboard.attach(handlers);
}

export function publishKeyboardPolicy(input: KeyboardPolicyInput): void {
  hardwareKeyboard.publishPolicy(input);
}

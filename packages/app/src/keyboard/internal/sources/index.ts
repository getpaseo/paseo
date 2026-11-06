import type { KeyboardSourceHandlers } from "./contract";
import { setHardwareKeyboardOverlayKeys, subscribeHardwareKeyboard } from "./hardware";
import { attachHardwareKeyboardSource } from "./native";
export function attachKeyboardSources(handlers: KeyboardSourceHandlers): () => void {
  return attachHardwareKeyboardSource(
    { subscribe: subscribeHardwareKeyboard, setOverlayKeys: setHardwareKeyboardOverlayKeys },
    handlers,
  );
}

export function publishKeyboardPolicy(_input: import("./contract").KeyboardPolicyInput): void {}

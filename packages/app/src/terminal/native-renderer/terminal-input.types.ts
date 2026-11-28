import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import type { NativeTerminalKeyEvent } from "./terminal-key-events";

export const TERMINAL_INPUT_HITBOX_SIZE = 1;
/**
 * Matched on Android by the hardware keyboard module to claim arrow keys for this input.
 */
export const TERMINAL_INPUT_NATIVE_ID = "paseo-terminal-input";

export type TerminalInputFocusRequest = "focus" | "refocus" | "none";

export interface TerminalInputHandle {
  focus: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

export interface TerminalInputProps {
  isKeyboardVisible: boolean;
  onFocus?: () => void;
  onInput?: (data: string) => void;
  onTerminalKey?: (event: NativeTerminalKeyEvent) => void;
  style?: StyleProp<ViewStyle & TextStyle>;
}

export function resolveTerminalInputFocusRequest(input: {
  isInputFocused: boolean;
  isKeyboardVisible: boolean;
}): TerminalInputFocusRequest {
  if (!input.isInputFocused) {
    return "focus";
  }
  return input.isKeyboardVisible ? "none" : "refocus";
}

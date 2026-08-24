import {
  encodeTerminalKeyInput,
  type TerminalKeyInput,
} from "@getpaseo/protocol/terminal-key-input";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import { normalizeTerminalTransportKey } from "@/utils/terminal-keys";

export interface TerminalKeyModifierState {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export const EMPTY_TERMINAL_KEY_MODIFIERS: TerminalKeyModifierState = {
  ctrl: false,
  shift: false,
  alt: false,
};

export const TERMINAL_VIRTUAL_KEY_BUTTONS = {
  esc: { id: "esc", label: "Esc", key: "Escape" },
  tab: { id: "tab", label: "Tab", key: "Tab" },
  up: { id: "up", label: "↑", key: "ArrowUp" },
  down: { id: "down", label: "↓", key: "ArrowDown" },
  left: { id: "left", label: "←", key: "ArrowLeft" },
  right: { id: "right", label: "→", key: "ArrowRight" },
  enter: { id: "enter", label: "Enter", key: "Enter" },
  backspace: { id: "backspace", label: "⌫", key: "Backspace" },
  space: { id: "space", label: "Space", key: " " },
} as const;

export function createTerminalKeyInput(input: {
  key: string;
  modifiers: TerminalKeyModifierState;
  meta?: boolean;
}): TerminalKeyInput {
  return {
    key: normalizeTerminalTransportKey(input.key),
    ctrl: input.modifiers.ctrl,
    shift: input.modifiers.shift,
    alt: input.modifiers.alt,
    meta: input.meta,
  };
}

export function dispatchTerminalKeyInput(input: {
  keyInput: TerminalKeyInput;
  inputMode: TerminalInputModeState;
  sendData: (data: string) => void;
}): void {
  const encoded = encodeTerminalKeyInput(input.keyInput, { inputMode: input.inputMode });
  if (encoded.length > 0) {
    input.sendData(encoded);
  }
}

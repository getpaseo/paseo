import {
  TERMINAL_VIRTUAL_KEY_BUTTONS,
  type TerminalKeyModifierState,
} from "./terminal-key-dispatch";

type TerminalVirtualKeyButton =
  (typeof TERMINAL_VIRTUAL_KEY_BUTTONS)[keyof typeof TERMINAL_VIRTUAL_KEY_BUTTONS];

export type TerminalVirtualKeyboardControl =
  | {
      type: "key";
      button: TerminalVirtualKeyButton;
    }
  | {
      type: "modifier";
      modifier: keyof TerminalKeyModifierState;
    }
  | {
      type: "paste";
    }
  | {
      type: "keyboardToggle";
    };

export const TERMINAL_VIRTUAL_KEYBOARD_ROWS = [
  [
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.esc },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.tab },
    { type: "modifier", modifier: "ctrl" },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.up },
    { type: "modifier", modifier: "shift" },
    { type: "keyboardToggle" },
  ],
  [
    { type: "modifier", modifier: "alt" },
    { type: "paste" },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.left },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.down },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.right },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.enter },
  ],
] as const satisfies readonly (readonly TerminalVirtualKeyboardControl[])[];

export function getTerminalVirtualKeyboardControlId(
  control: TerminalVirtualKeyboardControl,
): string {
  switch (control.type) {
    case "key":
      return `terminal-key-${control.button.id}`;
    case "modifier":
      return `terminal-key-${control.modifier}`;
    case "paste":
      return "terminal-paste";
    case "keyboardToggle":
      return "terminal-keyboard-toggle";
  }
}

export function shouldShowTerminalPasteAction(input: { isNative: boolean }): boolean {
  return input.isNative;
}

export function shouldShowTerminalFloatingCopyAction(input: {
  hasSelection: boolean;
  isNative: boolean;
}): boolean {
  return input.isNative && input.hasSelection;
}

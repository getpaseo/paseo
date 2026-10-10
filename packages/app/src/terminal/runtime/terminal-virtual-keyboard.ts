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

export const TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS = [
  [
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.esc },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.tab },
    { type: "modifier", modifier: "ctrl" },
    { type: "modifier", modifier: "alt" },
    { type: "modifier", modifier: "shift" },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.left },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.down },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.up },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.right },
    { type: "paste" },
    { type: "keyboardToggle" },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.enter },
  ],
] as const satisfies readonly (readonly TerminalVirtualKeyboardControl[])[];

export const TERMINAL_VIRTUAL_KEYBOARD_THREE_COLUMN_ROWS = [
  [
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.esc },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.tab },
    { type: "modifier", modifier: "ctrl" },
  ],
  [
    { type: "modifier", modifier: "alt" },
    { type: "modifier", modifier: "shift" },
    { type: "keyboardToggle" },
  ],
  [
    { type: "paste" },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.up },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.enter },
  ],
  [
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.left },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.down },
    { type: "key", button: TERMINAL_VIRTUAL_KEY_BUTTONS.right },
  ],
] as const satisfies readonly (readonly TerminalVirtualKeyboardControl[])[];

const TERMINAL_KEY_BAR_SINGLE_ROW_MIN_WIDTH = 660;
const TERMINAL_KEY_BAR_THREE_COLUMN_MAX_WIDTH = 300;

export function resolveTerminalVirtualKeyboardRows(input: {
  isCompact: boolean;
  availableWidth: number;
}) {
  if (input.availableWidth > 0 && input.availableWidth < TERMINAL_KEY_BAR_THREE_COLUMN_MAX_WIDTH) {
    return TERMINAL_VIRTUAL_KEYBOARD_THREE_COLUMN_ROWS;
  }
  return !input.isCompact && input.availableWidth >= TERMINAL_KEY_BAR_SINGLE_ROW_MIN_WIDTH
    ? TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS
    : TERMINAL_VIRTUAL_KEYBOARD_ROWS;
}

export function shouldShowTerminalVirtualKeyBar(input: {
  isNative: boolean;
  isCompact: boolean;
}): boolean {
  return input.isNative || input.isCompact;
}

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

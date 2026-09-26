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

// One row once the pane is wide. Two rows cost ~88pt of height; with the software keyboard up an
// iPad in landscape has only ~12 terminal lines left, and the bar is occasional-use. Trading a row
// of keys for two rows of terminal is the right way round. Arrows stay adjacent here instead of
// forming the compact layout's inverted T.
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

// Measured on device: a 698pt bar fits twelve keys with every label intact, a 515pt one truncates
// Shift, Paste and Enter. 660 sits between them and leaves each key 50pt, above the 44pt minimum
// touch target.
export const TERMINAL_KEY_BAR_SINGLE_ROW_MIN_WIDTH = 660;

// Measured bar width, not the window breakpoint. The window can be a tablet while the pane is
// half of one -- an open sidebar on an 11" portrait leaves ~515pt, where a single row truncates
// Shift, Paste and Enter and overflows the pane. Width 0 means the surface is not laid out yet,
// so fall back to the two-row layout, which fits everywhere.
export function resolveTerminalVirtualKeyboardRows(input: {
  isCompact: boolean;
  availableWidth: number;
}): readonly (readonly TerminalVirtualKeyboardControl[])[] {
  if (input.isCompact) {
    return TERMINAL_VIRTUAL_KEYBOARD_ROWS;
  }
  return input.availableWidth >= TERMINAL_KEY_BAR_SINGLE_ROW_MIN_WIDTH
    ? TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS
    : TERMINAL_VIRTUAL_KEYBOARD_ROWS;
}

// The key bar and the software-keyboard inset share this one condition. Width alone is the wrong
// signal: an iPad is never compact, yet its on-screen keyboard still covers the terminal and still
// has no Esc, no Ctrl and no arrows.
export function isTouchTerminalSurface(input: { isNative: boolean; isCompact: boolean }): boolean {
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

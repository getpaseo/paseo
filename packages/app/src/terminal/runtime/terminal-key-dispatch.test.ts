import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import { describe, expect, it } from "vitest";
import {
  createTerminalKeyInput,
  dispatchTerminalKeyInput,
  EMPTY_TERMINAL_KEY_MODIFIERS,
  TERMINAL_VIRTUAL_KEY_BUTTONS,
} from "./terminal-key-dispatch";

const NORMAL_MODE: TerminalInputModeState = {
  kittyKeyboardFlags: 0,
  win32InputMode: false,
  applicationCursorKeys: false,
};

const APPLICATION_CURSOR_MODE: TerminalInputModeState = {
  kittyKeyboardFlags: 0,
  win32InputMode: false,
  applicationCursorKeys: true,
};

function dispatchToolbarKey(input: { key: string; inputMode: TerminalInputModeState }): string[] {
  const sent: string[] = [];
  dispatchTerminalKeyInput({
    keyInput: createTerminalKeyInput({
      key: input.key,
      modifiers: EMPTY_TERMINAL_KEY_MODIFIERS,
    }),
    inputMode: input.inputMode,
    sendData: (data) => sent.push(data),
  });
  return sent;
}

describe("terminal key dispatch", () => {
  it("dispatches visible toolbar arrows through mode-aware terminal key encoding", () => {
    expect({
      normalUp: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.up.key,
        inputMode: NORMAL_MODE,
      }),
      normalDown: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.down.key,
        inputMode: NORMAL_MODE,
      }),
      normalLeft: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.left.key,
        inputMode: NORMAL_MODE,
      }),
      normalRight: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.right.key,
        inputMode: NORMAL_MODE,
      }),
      applicationCursorUp: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.up.key,
        inputMode: APPLICATION_CURSOR_MODE,
      }),
      applicationCursorDown: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.down.key,
        inputMode: APPLICATION_CURSOR_MODE,
      }),
      applicationCursorLeft: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.left.key,
        inputMode: APPLICATION_CURSOR_MODE,
      }),
      applicationCursorRight: dispatchToolbarKey({
        key: TERMINAL_VIRTUAL_KEY_BUTTONS.right.key,
        inputMode: APPLICATION_CURSOR_MODE,
      }),
    }).toEqual({
      normalUp: ["\x1b[A"],
      normalDown: ["\x1b[B"],
      normalLeft: ["\x1b[D"],
      normalRight: ["\x1b[C"],
      applicationCursorUp: ["\x1bOA"],
      applicationCursorDown: ["\x1bOB"],
      applicationCursorLeft: ["\x1bOD"],
      applicationCursorRight: ["\x1bOC"],
    });
  });
});

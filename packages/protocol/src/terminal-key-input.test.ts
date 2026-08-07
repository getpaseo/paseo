import { describe, expect, it } from "vitest";
import { encodeTerminalKeyInput } from "./terminal-key-input.js";

describe("encodeTerminalKeyInput", () => {
  it("encodes plain arrows as CSI when application cursor mode is inactive", () => {
    const options = { inputMode: { kittyKeyboardFlags: 0, win32InputMode: false } };

    expect({
      up: encodeTerminalKeyInput({ key: "ArrowUp" }, options),
      down: encodeTerminalKeyInput({ key: "ArrowDown" }, options),
      left: encodeTerminalKeyInput({ key: "ArrowLeft" }, options),
      right: encodeTerminalKeyInput({ key: "ArrowRight" }, options),
    }).toEqual({
      up: "\x1b[A",
      down: "\x1b[B",
      left: "\x1b[D",
      right: "\x1b[C",
    });
  });

  it("encodes plain arrows as SS3 when application cursor mode is active", () => {
    const options = {
      inputMode: { kittyKeyboardFlags: 0, win32InputMode: false, applicationCursorKeys: true },
    };

    expect({
      up: encodeTerminalKeyInput({ key: "ArrowUp" }, options),
      down: encodeTerminalKeyInput({ key: "ArrowDown" }, options),
      left: encodeTerminalKeyInput({ key: "ArrowLeft" }, options),
      right: encodeTerminalKeyInput({ key: "ArrowRight" }, options),
    }).toEqual({
      up: "\x1bOA",
      down: "\x1bOB",
      left: "\x1bOD",
      right: "\x1bOC",
    });
  });

  it("keeps modified arrows on CSI modifier sequences in application cursor mode", () => {
    const options = {
      inputMode: { kittyKeyboardFlags: 0, win32InputMode: false, applicationCursorKeys: true },
    };

    expect({
      shiftLeft: encodeTerminalKeyInput({ key: "ArrowLeft", shift: true }, options),
      altDown: encodeTerminalKeyInput({ key: "ArrowDown", alt: true }, options),
      ctrlRight: encodeTerminalKeyInput({ key: "ArrowRight", ctrl: true }, options),
      metaUp: encodeTerminalKeyInput({ key: "ArrowUp", meta: true }, options),
    }).toEqual({
      shiftLeft: "\x1b[1;2D",
      altDown: "\x1b[1;3B",
      ctrlRight: "\x1b[1;5C",
      metaUp: "\x1b[1;9A",
    });
  });

  it("encodes ctrl+b for tmux prefix", () => {
    expect(encodeTerminalKeyInput({ key: "b", ctrl: true })).toBe("\x02");
  });

  it("encodes shifted arrow key modifiers", () => {
    expect(encodeTerminalKeyInput({ key: "ArrowLeft", shift: true })).toBe("\x1b[1;2D");
  });

  it("encodes alt-modified printable keys", () => {
    expect(encodeTerminalKeyInput({ key: "x", alt: true })).toBe("\x1bx");
  });

  it("encodes enter and backspace", () => {
    expect(encodeTerminalKeyInput({ key: "Enter" })).toBe("\r");
    expect(encodeTerminalKeyInput({ key: "Backspace" })).toBe("\x7f");
  });

  it("keeps modified Enter as carriage return before enhanced input mode is active", () => {
    expect(encodeTerminalKeyInput({ key: "Enter", shift: true })).toBe("\r");
  });

  it("encodes Enter with modifiers using CSI u after Kitty keyboard mode is active", () => {
    const options = { inputMode: { kittyKeyboardFlags: 7, win32InputMode: false } };

    expect(encodeTerminalKeyInput({ key: "Enter", shift: true }, options)).toBe("\x1b[13;2u");
    expect(encodeTerminalKeyInput({ key: "Enter", ctrl: true }, options)).toBe("\x1b[13;5u");
    expect(encodeTerminalKeyInput({ key: "Enter", alt: true }, options)).toBe("\x1b[13;3u");
    expect(encodeTerminalKeyInput({ key: "Enter", meta: true }, options)).toBe("\x1b[13;9u");
    expect(encodeTerminalKeyInput({ key: "Enter", shift: true, ctrl: true }, options)).toBe(
      "\x1b[13;6u",
    );
  });

  it("encodes Shift+Enter using Win32 input mode when ConPTY requests it", () => {
    const options = { inputMode: { kittyKeyboardFlags: 0, win32InputMode: true } };

    expect(encodeTerminalKeyInput({ key: "Enter", shift: true }, options)).toBe(
      "\x1b[13;28;13;1;16;1_",
    );
  });

  it("prefers Win32 input mode over CSI u when both modes are active", () => {
    const options = { inputMode: { kittyKeyboardFlags: 7, win32InputMode: true } };

    expect(encodeTerminalKeyInput({ key: "Enter", shift: true }, options)).toBe(
      "\x1b[13;28;13;1;16;1_",
    );
  });

  it("returns empty string for unsupported keys", () => {
    expect(encodeTerminalKeyInput({ key: "UnidentifiedKey" })).toBe("");
  });
});

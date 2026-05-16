import { describe, expect, it } from "vitest";
import { encodeTerminalKeyInput } from "./terminal-key-input.js";

describe("encodeTerminalKeyInput", () => {
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

import { describe, expect, it } from "vitest";

import {
  createTerminalTextInputState,
  resolveTerminalInputFocusRequest,
  TERMINAL_INPUT_CONTEXT_MENU_HIDDEN,
  TERMINAL_INPUT_HITBOX_SIZE,
} from "./terminal-input.native";
import { forwardNativeTerminalKey, type NativeTerminalKeyEvent } from "./terminal-key-events";

describe("native terminal typed input", () => {
  function inputData(change: { data: string; shouldClear: boolean }): string {
    return change.data;
  }

  it("dispatches appended text once and ignores reset clears", () => {
    const input = createTerminalTextInputState();

    expect(inputData(input.receiveTextChange("h"))).toEqual("h");
    expect(inputData(input.receiveTextChange("hi"))).toEqual("i");

    input.reset();

    expect(input.receiveTextChange("")).toEqual({ data: "", shouldClear: false });
    expect(inputData(input.receiveTextChange(" there"))).toEqual(" there");
  });

  it("dispatches single-line multi-character inserts as one text payload", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("npm run typecheck")).toEqual({
      data: "npm run typecheck",
      shouldClear: false,
    });
  });

  it("dispatches printable keypresses when focused input does not report text changes", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveKeyPress("p")).toEqual({ data: "p", shouldClear: false });
    expect(input.receiveKeyPress("w")).toEqual({ data: "w", shouldClear: false });
    expect(input.receiveKeyPress("d")).toEqual({ data: "d", shouldClear: false });
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });
  });

  it("does not duplicate printable keypresses when the native text change also arrives", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveKeyPress("p")).toEqual({ data: "p", shouldClear: false });
    expect(input.receiveTextChange("p")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("w")).toEqual({ data: "w", shouldClear: false });
    expect(input.receiveTextChange("pw")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("d")).toEqual({ data: "d", shouldClear: false });
    expect(input.receiveTextChange("pwd")).toEqual({ data: "", shouldClear: false });
  });

  it("keeps anticipated text aligned after software keyboard Backspace", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveKeyPress("a")).toEqual({ data: "a", shouldClear: false });
    expect(input.receiveKeyPress("b")).toEqual({ data: "b", shouldClear: false });
    expect(input.receiveKeyPress("c")).toEqual({ data: "c", shouldClear: false });
    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });
    expect(input.receiveTextChange("ab")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("X")).toEqual({ data: "X", shouldClear: false });
    expect(input.receiveTextChange("abX")).toEqual({ data: "", shouldClear: false });
  });

  it("does not dispatch raw multiline hidden-input paste", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("printf one\nprintf two")).toEqual({
      data: "",
      shouldClear: true,
    });
  });

  it("does not dispatch raw carriage-return hidden-input paste", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("printf one\rprintf two")).toEqual({
      data: "",
      shouldClear: true,
    });
  });

  it("does not translate replacement edits into terminal text", () => {
    const input = createTerminalTextInputState();

    expect(inputData(input.receiveTextChange("abc"))).toEqual("abc");
    expect(input.receiveTextChange("aXc")).toEqual({ data: "", shouldClear: false });
  });

  it("clears accumulated hidden input text after terminal submit", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("echo hello")).toEqual({
      data: "echo hello",
      shouldClear: false,
    });
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });

    input.reset();

    expect(input.receiveTextChange("")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveTextChange("y")).toEqual({ data: "y", shouldClear: false });
  });

  it("ignores late newline text change after Return keypress submits", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("echo hello")).toEqual({
      data: "echo hello",
      shouldClear: false,
    });
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });

    input.reset();

    expect(input.receiveTextChange("echo hello\n")).toEqual({ data: "", shouldClear: false });
  });

  it("keeps long paste-like input intact until terminal submit", () => {
    const input = createTerminalTextInputState();
    const longText = "x".repeat(512);

    expect(input.receiveTextChange(longText)).toEqual({ data: longText, shouldClear: false });
    expect(input.receiveTextChange(`${longText}y`)).toEqual({ data: "y", shouldClear: false });
  });

  it("translates software keyboard terminal control keys", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });
    expect(input.receiveKeyPress("Return")).toEqual({ data: "\r", shouldClear: true });
    expect(input.receiveKeyPress("return")).toEqual({ data: "\r", shouldClear: true });
    expect(input.receiveTextChange("hello\n")).toEqual({ data: "", shouldClear: true });
  });

  it("emits semantic terminal key events for native arrow keypresses", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveKeyPress("ArrowUp")).toEqual({
      data: "",
      key: "ArrowUp",
      shouldClear: false,
    });
  });

  it("forwards native arrow key events to the terminal key path", () => {
    const events: NativeTerminalKeyEvent[] = [];

    forwardNativeTerminalKey({
      key: "ArrowUp",
      onTerminalKey: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([
      {
        key: "ArrowUp",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      },
    ]);
  });

  it("keeps the hidden input from owning terminal long-press selection", () => {
    expect({
      contextMenuHidden: TERMINAL_INPUT_CONTEXT_MENU_HIDDEN,
      hitboxSize: TERMINAL_INPUT_HITBOX_SIZE,
    }).toEqual({
      contextMenuHidden: true,
      hitboxSize: 1,
    });
  });

  it("refocuses after the keyboard hides while the hidden input stayed focused", () => {
    expect(resolveTerminalInputFocusRequest({ isInputFocused: true })).toEqual("refocus");
    expect(resolveTerminalInputFocusRequest({ isInputFocused: false })).toEqual("focus");
  });

  it("accepts fresh printable text after keyboard-hide reset and tap refocus", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("echo stale")).toEqual({
      data: "echo stale",
      shouldClear: false,
    });

    input.reset();

    expect(input.receiveTextChange("printf 'M1_TAP_OK\\n'")).toEqual({
      data: "printf 'M1_TAP_OK\\n'",
      shouldClear: false,
    });
  });
});

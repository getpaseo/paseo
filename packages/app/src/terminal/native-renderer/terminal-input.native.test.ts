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

    for (const key of "echo hello") {
      input.receiveKeyPress(key);
    }
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });

    input.reset();

    expect(input.receiveTextChange("")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveTextChange("y")).toEqual({ data: "y", shouldClear: false });
  });

  it("ignores late newline text change after Return keypress submits", () => {
    const input = createTerminalTextInputState();

    for (const key of "echo hello") {
      input.receiveKeyPress(key);
    }
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });

    input.reset();

    expect(input.receiveTextChange("echo hello\n")).toEqual({ data: "", shouldClear: false });
  });

  it("accepts the same long keyboard clipboard item twice", () => {
    const input = createTerminalTextInputState();
    const longText = "x".repeat(512);

    expect(input.receiveTextChange(longText)).toEqual({ data: longText, shouldClear: false });

    input.reset();

    expect(input.receiveTextChange(longText)).toEqual({ data: longText, shouldClear: false });
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

  it("does not disturb an already-focused input while the keyboard is visible", () => {
    expect(
      resolveTerminalInputFocusRequest({ isInputFocused: true, isKeyboardVisible: true }),
    ).toEqual("none");
    expect(
      resolveTerminalInputFocusRequest({ isInputFocused: true, isKeyboardVisible: false }),
    ).toEqual("refocus");
    expect(
      resolveTerminalInputFocusRequest({ isInputFocused: false, isKeyboardVisible: false }),
    ).toEqual("focus");
  });

  it("accepts the same keyboard clipboard item after terminal focus synchronization", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("echo clipboard item")).toEqual({
      data: "echo clipboard item",
      shouldClear: false,
    });

    input.reset();

    expect(input.receiveTextChange("echo clipboard item")).toEqual({
      data: "echo clipboard item",
      shouldClear: false,
    });
  });

  it("does not replay a stale IME suggestion when the native clear leaves composing text behind", () => {
    const input = createTerminalTextInputState();
    let typed = "";

    for (const key of "resta") {
      typed += key;
      input.receiveKeyPress(key);
      input.receiveTextChange(typed);
    }

    expect(input.receiveTextChange("restaurant ")).toEqual({
      data: "urant ",
      shouldClear: false,
    });

    expect(input.receiveTextChange("restaurant x")).toEqual({
      data: "x",
      shouldClear: false,
    });
  });

  it("types Hangul by rubbing out the syllable the IME rewrites in place", () => {
    const input = createTerminalTextInputState();

    // 한글: the composing syllable is rewritten on every jamo, never appended.
    expect(input.receiveTextChange("ㅎ")).toEqual({ data: "ㅎ", shouldClear: false });
    expect(input.receiveTextChange("하")).toEqual({ data: "\x7f하", shouldClear: false });
    expect(input.receiveTextChange("한")).toEqual({ data: "\x7f한", shouldClear: false });
    expect(input.receiveTextChange("한ㄱ")).toEqual({ data: "ㄱ", shouldClear: false });
    expect(input.receiveTextChange("한그")).toEqual({ data: "\x7f그", shouldClear: false });
    expect(input.receiveTextChange("한글")).toEqual({ data: "\x7f글", shouldClear: false });
  });

  it("types Hangul when a final consonant migrates into the next syllable", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("안")).toEqual({ data: "안", shouldClear: false });
    // Typing ㅣ moves ㄴ off 안 and onto the new syllable: 안 → 아니.
    expect(input.receiveTextChange("아니")).toEqual({ data: "\x7f아니", shouldClear: false });
  });

  it("does not dispatch Hangul through the keypress path", () => {
    const input = createTerminalTextInputState();

    // The IME reports the jamo it is composing; the text change reports the
    // syllable. Dispatching both would put two conflicting characters on the wire.
    expect(input.receiveKeyPress("ㅎ")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveTextChange("ㅎ")).toEqual({ data: "ㅎ", shouldClear: false });
    expect(input.receiveKeyPress("ㅏ")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveTextChange("하")).toEqual({ data: "\x7f하", shouldClear: false });
  });

  it("still swallows replacement edits wider than one composing syllable", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("한글")).toEqual({ data: "한글", shouldClear: false });
    // Two syllables at once is a suggestion replacement, not composition.
    expect(input.receiveTextChange("우리")).toEqual({ data: "", shouldClear: false });
  });

  it("does not treat a non-Hangul trailing edit as composition", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("ls -a")).toEqual({ data: "ls -a", shouldClear: false });
    expect(input.receiveTextChange("ls -l")).toEqual({ data: "", shouldClear: false });
  });

  it("keeps anticipated text aligned when Backspace decomposes a syllable", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("한")).toEqual({ data: "한", shouldClear: false });
    // The rubout already removed the whole syllable, so the redraw is a plain append.
    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });
    expect(input.receiveTextChange("하")).toEqual({ data: "하", shouldClear: false });
  });

  it("stops rubbing out once a swallowed replacement leaves the terminal ahead", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("한글")).toEqual({ data: "한글", shouldClear: false });
    // Swallowed: the terminal still holds 한글 while the buffer moved to 우리.
    expect(input.receiveTextChange("우리")).toEqual({ data: "", shouldClear: false });
    // A rubout here would delete 글 off the terminal and leave 한루 behind.
    expect(input.receiveTextChange("우루")).toEqual({ data: "", shouldClear: false });
  });

  it("resumes composition once the line is cleared", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveTextChange("한글")).toEqual({ data: "한글", shouldClear: false });
    expect(input.receiveTextChange("우리")).toEqual({ data: "", shouldClear: false });

    input.reset();

    expect(input.receiveTextChange("하")).toEqual({ data: "하", shouldClear: false });
    expect(input.receiveTextChange("한")).toEqual({ data: "\x7f한", shouldClear: false });
  });
});

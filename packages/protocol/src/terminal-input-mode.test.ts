import { describe, expect, it } from "vitest";
import { TerminalInputModeTracker } from "./terminal-input-mode.js";

describe("TerminalInputModeTracker", () => {
  it("activates from a pushed Kitty keyboard mode and builds a replay preamble", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[>7u").changed).toBe(true);

    expect(tracker.supportsModifiedEnter()).toBe(true);
    expect(tracker.getKittyKeyboardFlags()).toBe(7);
    expect(tracker.getPreamble()).toBe("\x1b[=7;1u");
  });

  it("tracks split terminal output chunks", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[>");
    const result = tracker.feed("1u");

    expect(result.changed).toBe(true);
    expect(tracker.getKittyKeyboardFlags()).toBe(1);
  });

  it("restores pushed Kitty keyboard modes when the foreground program pops them", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[>1u");
    tracker.feed("\x1b[>7u");
    expect(tracker.getKittyKeyboardFlags()).toBe(7);

    expect(tracker.feed("\x1b[<u").changed).toBe(true);
    expect(tracker.getKittyKeyboardFlags()).toBe(1);

    expect(tracker.feed("\x1b[<u").changed).toBe(true);
    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("answers Kitty keyboard mode queries with the current flags", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[=3;1u");

    expect(tracker.feed("\x1b[?u").responses).toEqual(["\x1b[?3u"]);
  });

  it("tracks ConPTY Win32 input mode and replays it after snapshots", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[?9001h").changed).toBe(true);

    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: true,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.supportsModifiedEnter()).toBe(true);
    expect(tracker.getPreamble()).toBe("\x1b[?9001h");

    expect(tracker.feed("\x1b[?9001l").changed).toBe(true);
    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("keeps Kitty and Win32 input modes independent", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[>7u\x1b[?9001h");

    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 7,
      win32InputMode: true,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("\x1b[=7;1u\x1b[?9001h");
  });

  it("tracks application cursor keys mode independently", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[?1h").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: true,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("\x1b[?1h");

    expect(tracker.feed("\x1b[?1l").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
  });

  it("tracks bracketed paste mode independently", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[?2004h").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: true,
    });
    expect(tracker.getPreamble()).toBe("\x1b[?2004h");

    expect(tracker.feed("\x1b[?2004l").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("");
  });

  it("ignores encoded key input sequences", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[13;2u");

    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("replays mouse tracking after a restore resets the terminal", () => {
    const tracker = new TerminalInputModeTracker();

    // Claude Code enables all three tracking protocols plus SGR encoding.
    tracker.feed("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");

    // xterm keeps the last protocol DECSET (ANY) and the SGR encoding.
    expect(tracker.getPreamble()).toBe("\x1b[?1003h\x1b[?1006h");

    // Any tracking DECRST clears the protocol but leaves the encoding.
    tracker.feed("\x1b[?1000l");
    expect(tracker.getPreamble()).toBe("\x1b[?1006h");

    tracker.feed("\x1b[?1006l");
    expect(tracker.getPreamble()).toBe("");
  });

  it("replays mouse tracking alongside the other replayed input modes", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[>5u");

    expect(tracker.getPreamble()).toBe("\x1b[=5;1u\x1b[?2004h\x1b[?1003h\x1b[?1006h");
  });

  it("replays focus reporting mode", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[?1004h");
    expect(tracker.getPreamble()).toBe("\x1b[?1004h");

    tracker.feed("\x1b[?1004l");
    expect(tracker.getPreamble()).toBe("");
  });

  it("does not report a public input-mode change for mouse-only sequences", () => {
    const tracker = new TerminalInputModeTracker();

    const result = tracker.feed("\x1b[?1000h");

    expect(result.changed).toBe(false);
    expect(tracker.getPreamble()).toBe("\x1b[?1000h");
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
  });
});

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

  const PI_FULLSCREEN_MOUSE_ENABLE =
    "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
  const PI_FULLSCREEN_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
  const wheelUpAt3x4 = { direction: "up" as const, col: 3, row: 4, pixelX: 30, pixelY: 80 };

  it("encodes SGR wheel reports while a fullscreen app tracks the mouse", () => {
    const tracker = new TerminalInputModeTracker();
    expect(tracker.encodeWheel(wheelUpAt3x4)).toBeNull();

    expect(tracker.feed(PI_FULLSCREEN_MOUSE_ENABLE).changed).toBe(true);

    expect(tracker.encodeWheel(wheelUpAt3x4)).toBe("\x1b[<64;3;4M");
    expect(tracker.encodeWheel({ ...wheelUpAt3x4, direction: "down" })).toBe("\x1b[<65;3;4M");
  });

  it("stops encoding wheel reports once the app disables mouse tracking", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed(PI_FULLSCREEN_MOUSE_ENABLE);

    expect(tracker.feed(PI_FULLSCREEN_MOUSE_DISABLE).changed).toBe(true);

    expect(tracker.encodeWheel(wheelUpAt3x4)).toBeNull();
    expect(tracker.getPreamble()).toBe("");
  });

  it("replays mouse tracking so a reconnected client keeps forwarding wheel input", () => {
    const daemon = new TerminalInputModeTracker();
    daemon.feed(PI_FULLSCREEN_MOUSE_ENABLE);
    const client = new TerminalInputModeTracker();
    client.feed(PI_FULLSCREEN_MOUSE_ENABLE);

    client.reset();
    expect(client.encodeWheel(wheelUpAt3x4)).toBeNull();
    expect(daemon.getPreamble()).toBe("\x1b[?1003h\x1b[?1006h");
    client.feed(daemon.getPreamble());

    expect(client.encodeWheel(wheelUpAt3x4)).toBe("\x1b[<64;3;4M");
  });

  it("encodes SGR pixel wheel reports with pixel coordinates", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[?1000h\x1b[?1016h");

    expect(tracker.encodeWheel(wheelUpAt3x4)).toBe("\x1b[<64;30;80M");
    expect(tracker.getPreamble()).toBe("\x1b[?1000h\x1b[?1016h");
  });

  it("encodes default wheel reports only while every byte stays ASCII", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[?1000h");

    expect(tracker.encodeWheel(wheelUpAt3x4)).toBe("\x1b[M`#$");
    expect(tracker.encodeWheel({ ...wheelUpAt3x4, col: 96 })).toBeNull();
    expect(tracker.encodeWheel({ ...wheelUpAt3x4, row: 96 })).toBeNull();
  });

  it("does not encode wheel reports for X10 press-only tracking", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[?9h\x1b[?1006h");

    expect(tracker.encodeWheel(wheelUpAt3x4)).toBeNull();
  });

  const tapAt3x4 = { col: 3, row: 4, pixelX: 30, pixelY: 80 };

  it.each([
    ["no tracking", "", null],
    ["SGR press/release", PI_FULLSCREEN_MOUSE_ENABLE, "\x1b[<0;3;4M\x1b[<0;3;4m"],
    ["SGR pixel press/release", "\x1b[?1000h\x1b[?1016h", "\x1b[<0;30;80M\x1b[<0;30;80m"],
    ["default press and button-3 release", "\x1b[?1000h", "\x1b[M #$\x1b[M##$"],
    ["X10 default press only", "\x1b[?9h", "\x1b[M #$"],
    ["X10 SGR press only", "\x1b[?9h\x1b[?1006h", "\x1b[<0;3;4M"],
    [
      "tracking disabled again",
      `${PI_FULLSCREEN_MOUSE_ENABLE}${PI_FULLSCREEN_MOUSE_DISABLE}`,
      null,
    ],
  ])("encodes a left click with %s", (_name, output, expected) => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed(output);

    expect(tracker.encodeLeftClick(tapAt3x4)).toBe(expected);
  });

  it("does not encode a default left click that leaves ASCII", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[?1000h");

    expect(tracker.encodeLeftClick({ ...tapAt3x4, col: 96 })).toBeNull();
  });

  it.each([["\x1bc"], ["\x1b", "c"]])(
    "clears every tracked mode on a full reset split as %j",
    (...chunks) => {
      const tracker = new TerminalInputModeTracker();
      tracker.feed(`\x1b[>7u\x1b[?2004h${PI_FULLSCREEN_MOUSE_ENABLE}`);

      const results = chunks.map((chunk) => tracker.feed(chunk));

      expect(results.at(-1)).toEqual({ changed: true, responses: [] });
      expect(tracker.getPreamble()).toBe("");
      expect(tracker.encodeWheel(wheelUpAt3x4)).toBeNull();
    },
  );

  it("ignores encoded key input sequences", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[13;2u");

    expect(tracker.supportsModifiedEnter()).toBe(false);
  });
});

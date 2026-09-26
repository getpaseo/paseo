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

  // PTY reads and output frames can split a sequence at any byte.
  function feedChunks(tracker: TerminalInputModeTracker, chunks: string[]) {
    let changes = 0;
    const responses: string[] = [];
    for (const chunk of chunks) {
      const result = tracker.feed(chunk);
      if (result.changed) changes += 1;
      responses.push(...result.responses);
    }
    return { changes, responses };
  }

  function everySplit(text: string): Array<[string, string[]]> {
    const cases: Array<[string, string[]]> = [];
    for (let index = 1; index < text.length; index += 1) {
      cases.push([`split at ${index}`, [text.slice(0, index), text.slice(index)]]);
    }
    cases.push(["one byte at a time", [...text]]);
    return cases;
  }

  it.each(everySplit("before\x1b[>5uafter"))("tracks a split Kitty push (%s)", (_name, chunks) => {
    const tracker = new TerminalInputModeTracker();

    expect(feedChunks(tracker, chunks)).toEqual({ changes: 1, responses: [] });
    expect(tracker.getKittyKeyboardFlags()).toBe(5);
  });

  it.each(everySplit("\x1b[?u\x1b[c"))("answers a split Kitty query once (%s)", (_name, chunks) => {
    const tracker = new TerminalInputModeTracker();

    expect(feedChunks(tracker, chunks)).toEqual({ changes: 0, responses: ["\x1b[?0u"] });
  });

  it.each(everySplit("before\x1b[>4;2mafter"))(
    "tracks a split modifyOtherKeys enable (%s)",
    (_name, chunks) => {
      const tracker = new TerminalInputModeTracker();

      expect(feedChunks(tracker, chunks)).toEqual({ changes: 1, responses: [] });
      expect(tracker.getState().modifyOtherKeys).toBe(2);
      expect(tracker.supportsModifiedEnter()).toBe(true);
    },
  );

  it.each(
    ["\x1b[>4;0m", "\x1b[>4m"].flatMap((reset) =>
      everySplit(`before${reset}after`).map(([name, chunks]) => [
        `${JSON.stringify(reset)} ${name}`,
        chunks,
      ]),
    ),
  )("tracks a split modifyOtherKeys reset (%s)", (_name, chunks) => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[>4;2m");

    expect(feedChunks(tracker, chunks)).toEqual({ changes: 1, responses: [] });
    expect(tracker.getState().modifyOtherKeys).toBe(0);
    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("tracks xterm modifyOtherKeys, which omp uses when the kitty query goes unanswered", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[>4;2m").changed).toBe(true);
    expect(tracker.supportsModifiedEnter()).toBe(true);
    expect(tracker.getPreamble()).toBe("\x1b[>4;2m");

    expect(tracker.feed("\x1b[>4;0m").changed).toBe(true);
    expect(tracker.supportsModifiedEnter()).toBe(false);
    expect(tracker.getPreamble()).toBe("");
  });

  it("does not treat modifyOtherKeys level 1 as modified Enter support", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[>4;1m");

    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("drops a lone trailing ESC that plain text follows", () => {
    const tracker = new TerminalInputModeTracker();

    expect(feedChunks(tracker, ["abc\x1b", "xyz"])).toEqual({ changes: 0, responses: [] });
    expect(tracker.getState()).toEqual(new TerminalInputModeTracker().getState());
    expect(feedChunks(tracker, ["\x1b[>5u"])).toEqual({ changes: 1, responses: [] });
    expect(tracker.getKittyKeyboardFlags()).toBe(5);
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
      modifyOtherKeys: 0,
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
      modifyOtherKeys: 0,
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
      modifyOtherKeys: 0,
    });
    expect(tracker.getPreamble()).toBe("\x1b[?1h");

    expect(tracker.feed("\x1b[?1l").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
      modifyOtherKeys: 0,
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
      modifyOtherKeys: 0,
    });
    expect(tracker.getPreamble()).toBe("\x1b[?2004h");

    expect(tracker.feed("\x1b[?2004l").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
      modifyOtherKeys: 0,
    });
    expect(tracker.getPreamble()).toBe("");
  });

  it("ignores encoded key input sequences", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[13;2u");

    expect(tracker.supportsModifiedEnter()).toBe(false);
  });
});

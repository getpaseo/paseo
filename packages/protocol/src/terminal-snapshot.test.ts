import { describe, it, expect } from "vitest";
import { renderTerminalSnapshotToAnsi } from "./terminal-snapshot";
import type { TerminalState } from "./messages";

function cells(text: string): TerminalState["grid"][number] {
  return [...text].map((char) => ({ char }));
}

describe("renderTerminalSnapshotToAnsi", () => {
  it("renders soft-wrapped rows as one contiguous logical line when wrap flags are present", () => {
    // The server soft-wrapped one logical line "ABCDEFGHIJKLMNOP" at 10 cols into
    // two grid rows. gridWrapped[0] = true marks row 0 as continuing into row 1.
    const state: TerminalState = {
      rows: 2,
      cols: 10,
      scrollback: [],
      scrollbackWrapped: [],
      grid: [cells("ABCDEFGHIJ"), cells("KLMNOP")],
      gridWrapped: [true, false],
      cursor: { row: 1, col: 6 },
    };

    const ansi = renderTerminalSnapshotToAnsi(state);

    // The rows must arrive unbroken so xterm re-wraps them itself (and can later
    // reflow them) — no hard newline injected between "...IJ" and "KL...".
    expect(ansi).toContain("ABCDEFGHIJKLMNOP");
    // Auto-wrap must stay enabled; disabling it (ESC[?7l) is what makes xterm mark
    // the rows non-wrapped and refuse to reflow them on resize.
    expect(ansi).not.toContain("[?7l");
  });

  it("falls back to verbatim per-row replay when wrap flags are absent (old daemon)", () => {
    // No gridWrapped/scrollbackWrapped: the client cannot tell soft-wraps from hard
    // newlines, so it must keep today's exact behaviour rather than guess.
    const state: TerminalState = {
      rows: 2,
      cols: 10,
      scrollback: [],
      grid: [cells("ABCDEFGHIJ"), cells("KLMNOP")],
      cursor: { row: 1, col: 6 },
    };

    const ansi = renderTerminalSnapshotToAnsi(state);

    expect(ansi).toContain("[?7l");
    expect(ansi).toContain("ABCDEFGHIJ\r\nKLMNOP");
  });
});

describe("renderTerminalSnapshotToAnsi wide chars", () => {
  it("skips wide-char continuation cells so the glyph keeps its two columns", () => {
    // The daemon captures "통" as the glyph followed by an empty continuation
    // cell. Emitting anything for that cell pushes the rest of the row right.
    const state: TerminalState = {
      rows: 1,
      cols: 10,
      scrollback: [],
      grid: [[{ char: "통" }, { char: "" }, { char: "합" }, { char: "" }, { char: "!" }]],
      cursor: { row: 0, col: 5 },
    };

    expect(renderTerminalSnapshotToAnsi(state)).toContain("통합!");
  });

  it("replays snapshots from an old daemon verbatim, including its continuation spaces", () => {
    // Old daemons already collapsed the continuation to " ". The serializer
    // cannot tell that apart from a real space, so it must not guess.
    const state: TerminalState = {
      rows: 1,
      cols: 10,
      scrollback: [],
      grid: [cells("통 합 !")],
      cursor: { row: 0, col: 6 },
    };

    expect(renderTerminalSnapshotToAnsi(state)).toContain("통 합 !");
  });
});

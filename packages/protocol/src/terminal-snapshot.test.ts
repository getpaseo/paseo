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

  it("skips wide-glyph placeholder cells so CJK rows replay without phantom columns", () => {
    // xterm stores a wide glyph like 界 as a width-2 content cell followed by a
    // width-0 placeholder cell. Emitting the placeholder's char would insert a
    // column that never existed, shifting the rest of the row right.
    const state: TerminalState = {
      rows: 1,
      cols: 6,
      scrollback: [],
      grid: [
        [
          { char: "A", width: 1 },
          { char: "界", width: 2 },
          { char: " ", width: 0 },
          { char: "B", width: 1 },
        ],
      ],
      cursor: { row: 0, col: 4 },
    };

    const ansi = renderTerminalSnapshotToAnsi(state);

    expect(ansi).toContain("A界B");
    expect(ansi).not.toContain("A界 B");
  });

  it("does not let a trailing wide-glyph placeholder extend the row", () => {
    // "界" at the start of an otherwise blank row: the placeholder at col 1 is
    // not content, so replay must not emit a trailing space after the glyph.
    const state: TerminalState = {
      rows: 1,
      cols: 6,
      scrollback: [],
      grid: [
        [
          { char: "界", width: 2 },
          { char: " ", width: 0 },
        ],
      ],
      cursor: { row: 0, col: 2 },
    };

    const ansi = renderTerminalSnapshotToAnsi(state);

    expect(ansi).toContain("界");
    expect(ansi).not.toContain("界 ");
  });
});

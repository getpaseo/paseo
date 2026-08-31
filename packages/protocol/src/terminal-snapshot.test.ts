import { describe, it, expect } from "vitest";
import { renderTerminalSnapshotToAnsi } from "./terminal-snapshot";
import type { TerminalState } from "./messages";

function cells(text: string): TerminalState["grid"][number] {
  return [...text].map((char) => ({ char }));
}

function wideCells(): TerminalState["grid"][number] {
  // The daemon serialises a double-width cell as the character plus the trailing
  // spacer cell that xterm reports as an empty string, which it writes as " ".
  return [
    { char: "한" },
    { char: " " },
    { char: "글" },
    { char: " " },
    { char: " " },
    { char: "A" },
  ];
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

  it("does not replay the spacer cell that follows a double-width character", () => {
    // Re-emitting the spacer turns every wide character into three columns when
    // the client writes the snapshot back into its terminal, so the restored row
    // drifts one column per CJK character.
    const state: TerminalState = {
      rows: 1,
      cols: 6,
      scrollback: [],
      scrollbackWrapped: [],
      grid: [wideCells()],
      gridWrapped: [false],
      cursor: { row: 0, col: 6 },
    };

    const ansi = renderTerminalSnapshotToAnsi(state);

    expect(ansi).toContain("한글 A");
    expect(ansi).not.toContain("한 글");
  });
});

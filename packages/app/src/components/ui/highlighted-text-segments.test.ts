import { describe, expect, it } from "vitest";
import { toHighlightSegments } from "./highlighted-text-segments";

/** What the eye sees, written back out with the marked runs bracketed. */
function marked(text: string, ranges: { start: number; length: number }[]): string {
  return toHighlightSegments(text, ranges)
    .map((segment) => (segment.marked ? `[${segment.text}]` : segment.text))
    .join("");
}

describe("toHighlightSegments", () => {
  it("marks one span and keeps the rest intact", () => {
    expect(marked("add stripe billing", [{ start: 4, length: 6 }])).toBe("add [stripe] billing");
  });

  it("marks several spans in order", () => {
    expect(
      marked("add stripe billing", [
        { start: 4, length: 6 },
        { start: 11, length: 4 },
      ]),
    ).toBe("add [stripe] [bill]ing");
  });

  it("marks a span at the very start and at the very end", () => {
    expect(marked("main", [{ start: 0, length: 4 }])).toBe("[main]");
    expect(marked("feat/main", [{ start: 5, length: 4 }])).toBe("feat/[main]");
  });

  it("clamps a range that runs past the end of the text", () => {
    expect(marked("main", [{ start: 2, length: 99 }])).toBe("ma[in]");
  });

  it("drops a range that starts past the end of the text", () => {
    expect(marked("main", [{ start: 99, length: 4 }])).toBe("main");
  });

  it("does not let overlapping ranges duplicate characters", () => {
    expect(
      marked("billing", [
        { start: 0, length: 4 },
        { start: 2, length: 5 },
      ]),
    ).toBe("[bill][ing]");
  });

  it("returns the whole text as one unmarked run when there are no ranges", () => {
    expect(toHighlightSegments("main", [])).toEqual([{ start: 0, text: "main", marked: false }]);
  });
});

import { describe, expect, it } from "vitest";
import { findHighlightRanges, toHighlightSegments } from "./highlighted-text-segments";

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

describe("findHighlightRanges", () => {
  it("highlights the same case-insensitive query independently in every field", () => {
    for (const text of ["Billing fixes", "Fix BILLING", "feat/billing", "billing-project"]) {
      expect(marked(text, findHighlightRanges("bill", text))).toContain(
        `[${text.slice(text.toLowerCase().indexOf("bill"), text.toLowerCase().indexOf("bill") + 4)}]`,
      );
    }
  });
  it("highlights the tokens present even when other words match another field", () => {
    expect(marked("Stripe billing", findHighlightRanges("stripe main", "Stripe billing"))).toBe(
      "[Stripe] billing",
    );
  });
  it("uses the search matcher for typo and scattered-character matches", () => {
    expect(marked("billing", findHighlightRanges("bulling", "billing"))).toBe("[billing]");
    expect(marked("paseo-babysit", findHighlightRanges("pasbab", "paseo-babysit"))).toBe(
      "[pas]eo-[bab]ysit",
    );
  });
  it("does not highlight a query assembled across separate words", () => {
    expect(
      findHighlightRanges(
        "terminal",
        "Let me diagnose this problem in a diagnose this problem and",
      ),
    ).toEqual([]);
    expect(marked("check configuration", findHighlightRanges("confg", "check configuration"))).toBe(
      "check [conf]i[g]uration",
    );
  });
  it("merges overlapping tokens and ignores empty or unmatched queries", () => {
    expect(marked("billing", findHighlightRanges("bill billing", "billing"))).toBe("[billing]");
    expect(findHighlightRanges("", "billing")).toEqual([]);
    expect(findHighlightRanges("xyz", "billing")).toEqual([]);
  });
});

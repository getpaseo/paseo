import { describe, expect, it } from "vitest";
import {
  clampFileFindIndex,
  computeFileFindMatches,
  decorateFileFindLineTokens,
  groupFileFindMatchesByLine,
  stepFileFindIndex,
} from "./file-find";

describe("computeFileFindMatches", () => {
  it("finds matches across lines in order", () => {
    expect(
      computeFileFindMatches({ lines: ["const foo = 1;", "return foo + foo;"], query: "foo" }),
    ).toEqual([
      { line: 1, start: 6, end: 9 },
      { line: 2, start: 7, end: 10 },
      { line: 2, start: 13, end: 16 },
    ]);
  });

  it("matches case-insensitively", () => {
    expect(computeFileFindMatches({ lines: ["FooBar fooBAR"], query: "foobar" })).toEqual([
      { line: 1, start: 0, end: 6 },
      { line: 1, start: 7, end: 13 },
    ]);
  });

  it("returns no matches for an empty query", () => {
    expect(computeFileFindMatches({ lines: ["anything"], query: "" })).toEqual([]);
  });

  it("does not count overlapping occurrences twice", () => {
    expect(computeFileFindMatches({ lines: ["aaaa"], query: "aa" })).toEqual([
      { line: 1, start: 0, end: 2 },
      { line: 1, start: 2, end: 4 },
    ]);
  });

  it("stops at the match limit", () => {
    expect(computeFileFindMatches({ lines: ["aaaa", "aaaa"], query: "a", limit: 5 })).toHaveLength(
      5,
    );
  });

  it("keeps offsets stable when lowercasing would change string length", () => {
    // "İ".toLowerCase() grows to two code units; the fold must not shift the
    // offsets of characters after it.
    expect(computeFileFindMatches({ lines: ["İabc"], query: "abc" })).toEqual([
      { line: 1, start: 1, end: 4 },
    ]);
  });

  it("matches Greek text even when query and line fold via different paths", () => {
    // The "İ" pushes the line onto the per-character fold path (final "Σ"
    // becomes "σ") while the query folds whole-string (final "Σ" becomes
    // "ς"); sigma normalization must reconcile the two.
    expect(computeFileFindMatches({ lines: ["İ ΛΟΓΟΣ"], query: "ΛΟΓΟΣ" })).toEqual([
      { line: 1, start: 2, end: 7 },
    ]);
  });

  it("matches a word-final-sigma query at non-final positions too", () => {
    expect(computeFileFindMatches({ lines: ["ΚΟΣΜΟΣ"], query: "ΟΣ" })).toEqual([
      { line: 1, start: 1, end: 3 },
      { line: 1, start: 4, end: 6 },
    ]);
  });

  it("treats final and medial lowercase sigma as equal", () => {
    expect(computeFileFindMatches({ lines: ["ΛΟΓΟΣΘΕΡΑΠΕΙΑ"], query: "λογος" })).toEqual([
      { line: 1, start: 0, end: 5 },
    ]);
  });

  it("only matches the exact case when caseSensitive is set", () => {
    expect(
      computeFileFindMatches({ lines: ["Foo foo FOO"], query: "foo", caseSensitive: true }),
    ).toEqual([{ line: 1, start: 4, end: 7 }]);
  });

  it("distinguishes sigma forms when caseSensitive is set", () => {
    expect(
      computeFileFindMatches({ lines: ["λογος λογοσ"], query: "λογος", caseSensitive: true }),
    ).toEqual([{ line: 1, start: 0, end: 5 }]);
  });

  it("returns no matches when the exact case is absent", () => {
    expect(
      computeFileFindMatches({ lines: ["foo bar"], query: "Foo", caseSensitive: true }),
    ).toEqual([]);
  });
});

describe("clampFileFindIndex", () => {
  it("returns zero when there are no matches", () => {
    expect(clampFileFindIndex(0, 3)).toBe(0);
  });

  it("clamps a stale index to the last match", () => {
    expect(clampFileFindIndex(2, 5)).toBe(1);
  });

  it("keeps a valid index unchanged", () => {
    expect(clampFileFindIndex(4, 2)).toBe(2);
  });
});

describe("stepFileFindIndex", () => {
  it("advances to the next match", () => {
    expect(stepFileFindIndex({ count: 3, index: 0, delta: 1 })).toBe(1);
  });

  it("wraps forward past the last match", () => {
    expect(stepFileFindIndex({ count: 3, index: 2, delta: 1 })).toBe(0);
  });

  it("wraps backward past the first match", () => {
    expect(stepFileFindIndex({ count: 3, index: 0, delta: -1 })).toBe(2);
  });

  it("returns zero when there are no matches", () => {
    expect(stepFileFindIndex({ count: 0, index: 0, delta: 1 })).toBe(0);
  });
});

describe("groupFileFindMatchesByLine", () => {
  it("groups matches by line preserving order", () => {
    const matches = [
      { line: 1, start: 0, end: 2 },
      { line: 1, start: 4, end: 6 },
      { line: 3, start: 1, end: 3 },
    ];
    const grouped = groupFileFindMatchesByLine(matches);
    expect(Array.from(grouped.keys())).toEqual([1, 3]);
    expect(grouped.get(1)).toEqual([
      { line: 1, start: 0, end: 2 },
      { line: 1, start: 4, end: 6 },
    ]);
    expect(grouped.get(3)).toEqual([{ line: 3, start: 1, end: 3 }]);
  });
});

describe("decorateFileFindLineTokens", () => {
  it("splits a token around a match inside it", () => {
    expect(
      decorateFileFindLineTokens({
        tokens: [{ text: "const foo = 1;", style: null }],
        matches: [{ line: 1, start: 6, end: 9 }],
        activeMatch: null,
      }),
    ).toEqual([
      { text: "const ", style: null },
      { text: "foo", style: null, find: "match" },
      { text: " = 1;", style: null },
    ]);
  });

  it("flags the active match as active and others as match", () => {
    expect(
      decorateFileFindLineTokens({
        tokens: [{ text: "foo foo", style: null }],
        matches: [
          { line: 1, start: 0, end: 3 },
          { line: 1, start: 4, end: 7 },
        ],
        activeMatch: { line: 1, start: 4, end: 7 },
      }),
    ).toEqual([
      { text: "foo", style: null, find: "match" },
      { text: " ", style: null },
      { text: "foo", style: null, find: "active" },
    ]);
  });

  it("flags every overlapped segment when a match spans several tokens", () => {
    expect(
      decorateFileFindLineTokens({
        tokens: [
          { text: "return", style: "keyword" },
          { text: " value", style: "variable" },
        ],
        matches: [{ line: 1, start: 4, end: 8 }],
        activeMatch: null,
      }),
    ).toEqual([
      { text: "retu", style: "keyword" },
      { text: "rn", style: "keyword", find: "match" },
      { text: " v", style: "variable", find: "match" },
      { text: "alue", style: "variable" },
    ]);
  });

  it("keeps token styles on unmatched segments", () => {
    expect(
      decorateFileFindLineTokens({
        tokens: [
          { text: "if", style: "keyword" },
          { text: "(x)", style: "punctuation" },
        ],
        matches: [{ line: 1, start: 3, end: 4 }],
        activeMatch: null,
      }),
    ).toEqual([
      { text: "if", style: "keyword" },
      { text: "(", style: "punctuation" },
      { text: "x", style: "punctuation", find: "match" },
      { text: ")", style: "punctuation" },
    ]);
  });

  it("passes through an empty line token", () => {
    expect(
      decorateFileFindLineTokens({
        tokens: [{ text: "", style: null }],
        matches: [],
        activeMatch: null,
      }),
    ).toEqual([{ text: "", style: null }]);
  });

  it("handles adjacent matches without gaps", () => {
    expect(
      decorateFileFindLineTokens({
        tokens: [{ text: "aaaa", style: null }],
        matches: [
          { line: 1, start: 0, end: 2 },
          { line: 1, start: 2, end: 4 },
        ],
        activeMatch: { line: 1, start: 2, end: 4 },
      }),
    ).toEqual([
      { text: "aa", style: null, find: "match" },
      { text: "aa", style: null, find: "active" },
    ]);
  });
});

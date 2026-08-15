import { describe, expect, it } from "vitest";

import { terminalWordShapingRanges } from "./terminal-word-shaping";

describe("terminalWordShapingRanges", () => {
  it("joins word runs", () => {
    expect(terminalWordShapingRanges("hello world")).toEqual([
      [0, 5],
      [6, 11],
    ]);
  });

  it("keeps identifiers whole across underscores and digits", () => {
    expect(terminalWordShapingRanges("src/main.ts")).toEqual([
      [0, 3],
      [4, 8],
      [9, 11],
    ]);
    expect(terminalWordShapingRanges("snake_case_42")).toEqual([[0, 13]]);
  });

  it("joins unicode letter runs", () => {
    expect(terminalWordShapingRanges("Überprüfung läuft")).toEqual([
      [0, 11],
      [12, 17],
    ]);
  });

  it("skips single characters, punctuation, spaces, and symbols", () => {
    expect(terminalWordShapingRanges("a => b -> c")).toEqual([]);
    expect(terminalWordShapingRanges("   ...---...   ")).toEqual([]);
  });

  it("returns no ranges for empty text", () => {
    expect(terminalWordShapingRanges("")).toEqual([]);
  });

  it("does not join across non-word boundaries like apostrophes or hyphens", () => {
    expect(terminalWordShapingRanges("don't well-known")).toEqual([
      [0, 3],
      [6, 10],
      [11, 16],
    ]);
  });
});

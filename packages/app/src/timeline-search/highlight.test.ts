import { describe, expect, it } from "vitest";
import { splitHighlightSegments, textMatchesQuery } from "./highlight";

describe("splitHighlightSegments", () => {
  it("returns a single non-match segment when the query is empty", () => {
    expect(splitHighlightSegments("hello world", "")).toEqual([
      { offset: 0, text: "hello world", isMatch: false },
    ]);
  });

  it("returns a single non-match segment when there is no match", () => {
    expect(splitHighlightSegments("hello world", "zzz")).toEqual([
      { offset: 0, text: "hello world", isMatch: false },
    ]);
  });

  it("splits around a single match (case-insensitive)", () => {
    expect(splitHighlightSegments("hello WORLD", "world")).toEqual([
      { offset: 0, text: "hello ", isMatch: false },
      { offset: 6, text: "WORLD", isMatch: true },
    ]);
  });

  it("splits around multiple matches with correct offsets", () => {
    expect(splitHighlightSegments("aXaXa", "x")).toEqual([
      { offset: 0, text: "a", isMatch: false },
      { offset: 1, text: "X", isMatch: true },
      { offset: 2, text: "a", isMatch: false },
      { offset: 3, text: "X", isMatch: true },
      { offset: 4, text: "a", isMatch: false },
    ]);
  });

  it("handles a match at the very start", () => {
    expect(splitHighlightSegments("world!", "world")).toEqual([
      { offset: 0, text: "world", isMatch: true },
      { offset: 5, text: "!", isMatch: false },
    ]);
  });

  it("preserves the original casing of the matched text", () => {
    const segments = splitHighlightSegments("The DEPLOY step", "deploy");
    expect(segments.find((s) => s.isMatch)?.text).toBe("DEPLOY");
  });

  it("keeps offsets valid when a character's lowercase form changes length", () => {
    // "İ".toLowerCase() is two code units, so lowercase-offset slicing would
    // mis-align. The match must still land on the real "a" at offset 1.
    const segments = splitHighlightSegments("İa", "a");
    expect(segments).toEqual([
      { offset: 0, text: "İ", isMatch: false },
      { offset: 1, text: "a", isMatch: true },
    ]);
  });
});

describe("textMatchesQuery", () => {
  it("agrees with splitHighlightSegments on Unicode case folding (no match)", () => {
    // "İstanbul".toLowerCase() contains "i", but the Unicode-aware regex used
    // for highlighting does not match "İ" against /i/giu — detection must
    // use the same semantics so a "counted" match is always highlightable.
    expect(textMatchesQuery("İstanbul", "i")).toBe(false);
    expect(splitHighlightSegments("İstanbul", "i").some((s) => s.isMatch)).toBe(false);
  });

  it("agrees with splitHighlightSegments on plain ASCII case-insensitivity (match)", () => {
    expect(textMatchesQuery("Istanbul", "i")).toBe(true);
    expect(splitHighlightSegments("Istanbul", "i").some((s) => s.isMatch)).toBe(true);
  });

  it("returns false for an empty query", () => {
    expect(textMatchesQuery("hello", "")).toBe(false);
  });

  it("returns false for an empty text", () => {
    expect(textMatchesQuery("", "hello")).toBe(false);
  });
});

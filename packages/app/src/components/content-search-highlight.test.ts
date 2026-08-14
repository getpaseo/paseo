import { describe, it, expect } from "vitest";
import { splitHighlightSegments } from "./content-search-highlight";

describe("splitHighlightSegments", () => {
  it("splits around every case-insensitive occurrence", () => {
    expect(splitHighlightSegments("a Needle and NEEDLE", "needle")).toEqual([
      { text: "a ", hit: false },
      { text: "Needle", hit: true },
      { text: " and ", hit: false },
      { text: "NEEDLE", hit: true },
    ]);
  });

  it("returns a single plain segment when there is no hit", () => {
    expect(splitHighlightSegments("plain text", "zzz")).toEqual([
      { text: "plain text", hit: false },
    ]);
  });

  it("handles adjacent occurrences", () => {
    expect(splitHighlightSegments("abab", "ab")).toEqual([
      { text: "ab", hit: true },
      { text: "ab", hit: true },
    ]);
  });

  it("returns a single segment for an empty query", () => {
    expect(splitHighlightSegments("anything", "")).toEqual([{ text: "anything", hit: false }]);
  });
});

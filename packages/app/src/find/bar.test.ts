import { describe, expect, it } from "vitest";
import { findCountLabel } from "./bar";

function t(key: string, options?: Record<string, number>): string {
  return options ? `${key} ${JSON.stringify(options)}` : key;
}

describe("findCountLabel", () => {
  it("says nothing until something is typed", () => {
    expect(findCountLabel({ query: "", result: { count: 3, activeIndex: 0 }, t })).toBe("");
  });

  it("reports an empty search", () => {
    expect(findCountLabel({ query: "needle", result: { count: 0, activeIndex: null }, t })).toBe(
      "find.noResults",
    );
  });

  it("names the active match as a 1-based position", () => {
    expect(findCountLabel({ query: "needle", result: { count: 9, activeIndex: 2 }, t })).toBe(
      'find.matchPosition {"current":3,"count":9}',
    );
  });

  it("names the first match while an engine has not activated one yet", () => {
    expect(findCountLabel({ query: "needle", result: { count: 9, activeIndex: null }, t })).toBe(
      'find.matchPosition {"current":1,"count":9}',
    );
  });

  // xterm's search addon tracks only the matches it highlighted, so an active match past
  // its limit reports -1 forever; "1 of 1000" would name a match nowhere near the screen.
  it("reports a floor instead of a position when the count is capped", () => {
    expect(
      findCountLabel({
        query: "error",
        result: { count: 1000, activeIndex: null, countIsCapped: true },
        t,
      }),
    ).toBe('find.cappedCount {"count":1000}');
  });

  // The CodeMirror engine caps counting but still knows which counted match is active, so
  // the position is real while the total is only a floor: "5 of 1000" would claim a total
  // the engine never established.
  it("keeps the position but marks the total as a floor when a capped engine knows it", () => {
    expect(
      findCountLabel({
        query: "error",
        result: { count: 1000, activeIndex: 4, countIsCapped: true },
        t,
      }),
    ).toBe('find.matchPositionCapped {"current":5,"count":1000}');
  });
});

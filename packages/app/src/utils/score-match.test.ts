import { describe, expect, it } from "vitest";

import { compareMatchScores, scoreMatch } from "./score-match";

describe("scoreMatch", () => {
  it("returns tier 0 for empty query", () => {
    expect(scoreMatch("", "anything")).toEqual({ tier: 0, offset: 0 });
  });

  it("returns tier 0 for exact match ignoring case", () => {
    expect(scoreMatch("pi", "pi")).toEqual({ tier: 0, offset: 0 });
    expect(scoreMatch("PI", "pi")).toEqual({ tier: 0, offset: 0 });
    expect(scoreMatch("Pi", "pI")).toEqual({ tier: 0, offset: 0 });
  });

  it("returns tier 1 for whole-word match at start", () => {
    expect(scoreMatch("feat", "feat/pi-direct-sdk")).toEqual({ tier: 1, offset: 0 });
  });

  it("returns tier 1 for whole-word match in middle (word boundaries on both sides)", () => {
    expect(scoreMatch("pi", "feat/pi-direct-sdk")).toEqual({ tier: 1, offset: 5 });
    expect(scoreMatch("pi", "a b pi c d")).toEqual({ tier: 1, offset: 4 });
  });

  it("returns tier 2 for string prefix that does not complete a word", () => {
    expect(scoreMatch("par", "party")).toEqual({ tier: 2, offset: 0 });
  });

  it("returns tier 3 for word-boundary start that does not complete a word", () => {
    expect(scoreMatch("par", "a/party")).toEqual({ tier: 3, offset: 2 });
  });

  it("returns tier 4 for substring inside a word", () => {
    expect(scoreMatch("art", "party")).toEqual({ tier: 4, offset: 1 });
  });

  it("returns null when query is not found", () => {
    expect(scoreMatch("xyz", "feat/pi-direct-sdk")).toBeNull();
  });

  it("picks the best tier across multiple occurrences", () => {
    expect(scoreMatch("ab", "xabxab-yy")).toEqual({ tier: 4, offset: 1 });
    expect(scoreMatch("ab", "xxab x-ab-y")).toEqual({ tier: 1, offset: 7 });
  });

  it("prefers earlier offset when tiers are equal", () => {
    expect(scoreMatch("pi", "pi-a pi-b")).toEqual({ tier: 1, offset: 0 });
  });

  it("treats common separators as word boundaries", () => {
    expect(scoreMatch("pi", "x/pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x-pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x_pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x.pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x:pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("202", "#202 feat")).toEqual({ tier: 1, offset: 1 });
  });

  it("scores PR-title-shaped text realistically", () => {
    const pr202 = "#202 feat(server): replace Pi ACP with direct SDK provider";
    expect(scoreMatch("pi", pr202)?.tier).toBe(1);
    expect(scoreMatch("202", pr202)).toEqual({ tier: 1, offset: 1 });
    expect(scoreMatch("replace", pr202)?.tier).toBe(1);
  });
});

describe("compareMatchScores", () => {
  it("sorts by tier ascending", () => {
    expect(compareMatchScores({ tier: 1, offset: 10 }, { tier: 2, offset: 0 })).toBeLessThan(0);
    expect(compareMatchScores({ tier: 3, offset: 0 }, { tier: 1, offset: 99 })).toBeGreaterThan(0);
  });

  it("tie-breaks by offset ascending at the same tier", () => {
    expect(compareMatchScores({ tier: 1, offset: 0 }, { tier: 1, offset: 5 })).toBeLessThan(0);
    expect(compareMatchScores({ tier: 1, offset: 5 }, { tier: 1, offset: 5 })).toBe(0);
  });
});

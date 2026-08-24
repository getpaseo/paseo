import { describe, expect, it } from "vitest";
import { normalizeDisplayChord } from "./normalize-display-chord";

describe("normalizeDisplayChord", () => {
  it("returns null when neither keys nor chord is given", () => {
    expect(normalizeDisplayChord()).toBeNull();
  });

  it("returns null for an empty keys array", () => {
    // The trap: [] wraps to [[]], whose first element is truthy.
    expect(normalizeDisplayChord(undefined, [])).toBeNull();
  });

  it("returns null for an empty chord", () => {
    expect(normalizeDisplayChord([])).toBeNull();
  });

  it("returns null for a chord holding an empty combo", () => {
    expect(normalizeDisplayChord([[]])).toBeNull();
    expect(normalizeDisplayChord([["mod", "K"], []])).toBeNull();
  });

  it("wraps keys into a single-combo chord", () => {
    expect(normalizeDisplayChord(undefined, ["mod", "K"])).toEqual([["mod", "K"]]);
  });

  it("passes a multi-step chord through unchanged", () => {
    expect(normalizeDisplayChord([["mod", "K"], ["S"]])).toEqual([["mod", "K"], ["S"]]);
  });

  it("prefers chord over keys when both are given", () => {
    expect(normalizeDisplayChord([["alt", "W"]], ["mod", "K"])).toEqual([["alt", "W"]]);
  });
});

import { describe, expect, it } from "vitest";
import { resolveFindSeed } from "./find-seed";

describe("resolveFindSeed", () => {
  it("seeds the top of the visible screen for a term the addon has not searched", () => {
    expect(
      resolveFindSeed({ term: "needle", previousTerm: null, hasSelection: false, viewportY: 120 }),
    ).toEqual({ column: 0, row: 120, length: 1 });
  });

  it("seeds again when the term changed", () => {
    expect(
      resolveFindSeed({ term: "needle", previousTerm: "nee", hasSelection: false, viewportY: 7 }),
    ).toEqual({ column: 0, row: 7, length: 1 });
  });

  // Repeating the same term is how the addon steps to the next match; re-seeding would
  // pin every step back to the top of the screen.
  it("leaves the start alone while stepping through the same term", () => {
    expect(
      resolveFindSeed({ term: "needle", previousTerm: "needle", hasSelection: true, viewportY: 7 }),
    ).toBeNull();
  });

  it("leaves a selection the user made as the search start", () => {
    expect(
      resolveFindSeed({ term: "needle", previousTerm: null, hasSelection: true, viewportY: 9 }),
    ).toBeNull();
  });
});

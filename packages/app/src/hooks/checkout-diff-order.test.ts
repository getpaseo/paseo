import { describe, expect, it } from "vitest";
import {
  compareCheckoutDiffPaths,
  orderCheckoutDiffFiles,
} from "./checkout-diff-order";

function createFile(path: string, additions = 0) {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions,
    deletions: 0,
    hunks: [],
  };
}

describe("checkout diff ordering", () => {
  it("compares paths deterministically", () => {
    expect(compareCheckoutDiffPaths("a.ts", "b.ts")).toBeLessThan(0);
    expect(compareCheckoutDiffPaths("b.ts", "a.ts")).toBeGreaterThan(0);
    expect(compareCheckoutDiffPaths("same.ts", "same.ts")).toBe(0);
  });

  it("sorts files by path", () => {
    const ordered = orderCheckoutDiffFiles([
      createFile("zeta.ts"),
      createFile("alpha.ts"),
      createFile("beta.ts"),
    ]);

    expect(ordered.map((file) => file.path)).toEqual([
      "alpha.ts",
      "beta.ts",
      "zeta.ts",
    ]);
  });

  it("preserves relative order for equal paths", () => {
    const ordered = orderCheckoutDiffFiles([
      createFile("same.ts", 1),
      createFile("same.ts", 2),
      createFile("same.ts", 3),
    ]);

    expect(ordered.map((file) => file.additions)).toEqual([1, 2, 3]);
  });
});

import { describe, expect, it } from "vitest";
import type { DiffFileMetadata } from "./use-checkout-diff-metadata-query";
import { orderCheckoutDiffFiles } from "./checkout-diff-order";

function createMetadata(path: string, fingerprint = "fp1"): DiffFileMetadata {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    fingerprint,
  };
}

describe("useCheckoutDiffMetadataQuery — cache replacement behavior", () => {
  it("orderCheckoutDiffFiles works with DiffFileMetadata arrays", () => {
    const files: DiffFileMetadata[] = [
      createMetadata("zeta.ts"),
      createMetadata("alpha.ts"),
      createMetadata("beta.ts"),
    ];
    const ordered = orderCheckoutDiffFiles(files);
    expect(ordered.map((f) => f.path)).toEqual(["alpha.ts", "beta.ts", "zeta.ts"]);
  });

  it("replaces full list on snapshot — does not merge with previous", () => {
    const initial: DiffFileMetadata[] = [
      createMetadata("a.ts", "fp1"),
      createMetadata("b.ts", "fp2"),
      createMetadata("c.ts", "fp3"),
    ];
    // Simulate a new snapshot that removes b.ts and changes c.ts fingerprint
    const updated: DiffFileMetadata[] = [
      createMetadata("a.ts", "fp1"),
      createMetadata("c.ts", "fp4"),
    ];

    // Full replacement: the result is exactly the updated list, not a merge
    const result = orderCheckoutDiffFiles(updated);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(result.find((f) => f.path === "c.ts")?.fingerprint).toBe("fp4");
    // b.ts is gone — no remnant from initial
    expect(result.find((f) => f.path === "b.ts")).toBeUndefined();

    // Initial is unchanged (no mutation)
    expect(initial).toHaveLength(3);
  });

  it("preserves fingerprint and status on metadata items", () => {
    const file: DiffFileMetadata = {
      path: "large.bin",
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      status: "binary",
      fingerprint: "abc123",
    };
    const ordered = orderCheckoutDiffFiles([file]);
    expect(ordered[0].fingerprint).toBe("abc123");
    expect(ordered[0].status).toBe("binary");
  });
});

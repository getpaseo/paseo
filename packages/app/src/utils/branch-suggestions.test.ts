import { describe, expect, it } from "vitest";
import { buildBranchComboOptions, normalizeBranchOptionName } from "./branch-suggestions";

describe("normalizeBranchOptionName", () => {
  it("normalizes local and origin-prefixed refs", () => {
    expect(normalizeBranchOptionName("refs/heads/main")).toBe("main");
    expect(normalizeBranchOptionName("refs/remotes/origin/main")).toBe("main");
    expect(normalizeBranchOptionName("origin/feature/test")).toBe("feature/test");
    expect(normalizeBranchOptionName("feature/test")).toBe("feature/test");
  });

  it("filters out empty values and HEAD", () => {
    expect(normalizeBranchOptionName("")).toBeNull();
    expect(normalizeBranchOptionName("   ")).toBeNull();
    expect(normalizeBranchOptionName("HEAD")).toBeNull();
    expect(normalizeBranchOptionName("origin/HEAD")).toBeNull();
  });
});

describe("buildBranchComboOptions", () => {
  it("merges branch sources and de-duplicates normalized names", () => {
    const options = buildBranchComboOptions({
      suggestedBranches: ["origin/main", "refs/remotes/origin/main", "feature/a"],
      currentBranch: "refs/heads/feature/a",
      baseRef: "origin/main",
      typedBaseBranch: "main",
      worktreeBranchLabels: ["refs/heads/release/next"],
    });

    expect(options).toEqual([
      { id: "main", label: "main" },
      { id: "feature/a", label: "feature/a" },
      { id: "release/next", label: "release/next" },
    ]);
  });
});

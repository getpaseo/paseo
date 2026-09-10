import { describe, expect, it } from "vitest";
import { describeResultPath } from "./result-path";

describe("describeResultPath", () => {
  it("keeps a root file whole", () => {
    expect(describeResultPath("README.md")).toEqual({ directory: "", name: "README.md" });
  });

  it("keeps a shallow path whole", () => {
    expect(describeResultPath("docs/architecture.md")).toEqual({
      directory: "docs/",
      name: "architecture.md",
    });
  });

  it("elides the head of a deep path and keeps the distinguishing parent", () => {
    // These two rows are both "index.tsx"; the parents are the only thing telling them apart.
    expect(
      describeResultPath("packages/app/src/command-center/workspace-content-search/index.tsx"),
    ).toEqual({ directory: "…/workspace-content-search/", name: "index.tsx" });
    expect(describeResultPath("packages/app/src/file-pane/source/index.tsx")).toEqual({
      directory: "…/source/",
      name: "index.tsx",
    });
  });

  it("keeps a literal backslash in a file name out of the directory", () => {
    expect(describeResultPath("a\\b.txt")).toEqual({ directory: "", name: "a\\b.txt" });
  });
});

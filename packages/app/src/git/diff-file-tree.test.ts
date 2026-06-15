import { describe, expect, it } from "vitest";
import {
  buildDiffFileTree,
  flattenDiffFileTree,
  type DiffFileTreeInputFile,
} from "./diff-file-tree";

function file(path: string, additions: number, deletions: number): DiffFileTreeInputFile {
  return { path, additions, deletions };
}

describe("buildDiffFileTree", () => {
  it("groups changed files by repository directory and aggregates stats", () => {
    const tree = buildDiffFileTree([
      file("README.md", 1, 0),
      file("packages/app/src/main.tsx", 5, 2),
      file("packages/app/src/styles.ts", 3, 1),
      file("packages/server/index.ts", 7, 4),
    ]);

    expect(tree.map((node) => node.path)).toEqual(["README.md", "packages"]);
    const packages = tree[1];
    expect(packages).toMatchObject({
      type: "directory",
      name: "packages",
      path: "packages",
      additions: 15,
      deletions: 7,
      depth: 0,
    });
    expect(
      packages?.type === "directory" ? packages.children.map((node) => node.path) : [],
    ).toEqual(["packages/app", "packages/server"]);
  });

  it("flattens only visible descendants when a directory is collapsed", () => {
    const tree = buildDiffFileTree([
      file("packages/app/src/main.tsx", 5, 2),
      file("packages/server/index.ts", 7, 4),
    ]);

    const flattened = flattenDiffFileTree({
      nodes: tree,
      collapsedDirectoryPaths: new Set(["packages/app"]),
    });

    expect(flattened.map((item) => item.node.path)).toEqual([
      "packages",
      "packages/app",
      "packages/server",
      "packages/server/index.ts",
    ]);
  });
});

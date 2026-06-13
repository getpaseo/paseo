import { describe, expect, it } from "vitest";
import { buildDiffTree, type DiffTreeInputFile } from "./diff-tree";

const files: DiffTreeInputFile[] = [
  { path: "src/git/diff-pane.tsx", additions: 42, deletions: 7 },
  { path: "src/git/use-diff-query.ts", additions: 5, deletions: 0 },
  { path: "src/components/diff-stat.tsx", additions: 18, deletions: 3 },
  { path: "README.md", additions: 1, deletions: 1 },
];

describe("buildDiffTree", () => {
  it("groups files into directories with aggregated stats when fully expanded", () => {
    const expanded = new Set(["src", "src/git", "src/components"]);
    const rows = buildDiffTree({ files, expandedPaths: expanded });
    const srcDir = rows.find((r) => r.kind === "directory" && r.path === "src");
    expect(srcDir).toMatchObject({ kind: "directory", depth: 0, additions: 65, deletions: 10 });
    expect(rows[0]).toMatchObject({ kind: "directory", path: "src" });
    const gitFile = rows.find((r) => r.kind === "file" && r.path === "src/git/diff-pane.tsx");
    expect(gitFile?.depth).toBe(2);
  });

  it("hides descendants of a collapsed directory", () => {
    const expanded = new Set<string>();
    const rows = buildDiffTree({ files, expandedPaths: expanded });
    expect(rows.some((r) => r.kind === "file" && r.path.startsWith("src/"))).toBe(false);
    expect(rows.some((r) => r.kind === "directory" && r.path === "src")).toBe(true);
    expect(rows.some((r) => r.kind === "file" && r.path === "README.md")).toBe(true);
  });

  it("sorts directories before files and alphabetically at each level", () => {
    const expanded = new Set(["src"]);
    const rows = buildDiffTree({ files, expandedPaths: expanded });
    // within src: components (dir) before git (dir); no files directly in src
    const srcChildren = rows.filter((r) => r.depth === 1);
    expect(srcChildren.map((r) => r.name)).toEqual(["components", "git"]);
    // root order: src (dir) before README.md (file)
    const root = rows.filter((r) => r.depth === 0);
    expect(root[0]).toMatchObject({ kind: "directory", name: "src" });
    expect(root[root.length - 1]).toMatchObject({ kind: "file", name: "README.md" });
  });

  it("emits root-level files at depth 0 and nested directory aggregates", () => {
    const expanded = new Set(["src", "src/git"]);
    const rows = buildDiffTree({ files, expandedPaths: expanded });
    const gitDir = rows.find((r) => r.kind === "directory" && r.path === "src/git");
    expect(gitDir).toMatchObject({ kind: "directory", depth: 1, additions: 47, deletions: 7 });
    const readme = rows.find((r) => r.kind === "file" && r.path === "README.md");
    expect(readme?.depth).toBe(0);
    // src/components is collapsed → its file is omitted, dir row still present
    expect(rows.some((r) => r.kind === "file" && r.path === "src/components/diff-stat.tsx")).toBe(
      false,
    );
    expect(rows.some((r) => r.kind === "directory" && r.path === "src/components")).toBe(true);
  });
});

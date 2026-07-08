import { describe, expect, it } from "vitest";
import { buildDiffFlatItems, sumHeightsBefore, type DiffFlatItem } from "./diff-flat-items";
import type { ParsedDiffFile } from "@/git/use-diff-query";

function createFile(path: string, additions = 1, deletions = 0): ParsedDiffFile {
  return { path, isNew: false, isDeleted: false, additions, deletions, hunks: [] };
}

function summarize(items: DiffFlatItem[]): string[] {
  return items.map((item) => {
    if (item.type === "folder") {
      return `${"  ".repeat(item.depth)}[${item.displayName}]${item.collapsed ? " (collapsed)" : ""}`;
    }
    const base = item.file.path.split("/").pop();
    return `${"  ".repeat(item.depth)}${item.type === "body" ? "body:" : ""}${base}`;
  });
}

describe("buildDiffFlatItems", () => {
  const files = [createFile("src/app/a.ts"), createFile("src/app/nested/b.ts")];

  it("emits a body and a sticky index for each expanded file", () => {
    const { items, stickyHeaderIndices } = buildDiffFlatItems({
      files: [createFile("a.ts"), createFile("b.ts")],
      viewMode: "tree",
      collapsedFolders: new Set(),
      expandedPaths: new Set(["a.ts"]),
    });
    // Root-level files (no folder): header, body (for expanded a.ts), header
    expect(summarize(items)).toEqual(["a.ts", "body:a.ts", "b.ts"]);
    // sticky points at the header (index 0), not the body
    expect(stickyHeaderIndices).toEqual([0]);
    expect(items[0].type).toBe("header");
  });

  it("emits the old flat list without folder rows or indentation", () => {
    const { items, stickyHeaderIndices } = buildDiffFlatItems({
      files,
      viewMode: "flat",
      collapsedFolders: new Set(),
      expandedPaths: new Set(["src/app/a.ts"]),
    });

    expect(summarize(items)).toEqual(["a.ts", "body:a.ts", "b.ts"]);
    expect(stickyHeaderIndices).toEqual([0]);
    expect(items.every((item) => item.type !== "folder")).toBe(true);
  });

  it("groups files under compressed folder rows, all expanded by default", () => {
    const { items } = buildDiffFlatItems({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(),
      expandedPaths: new Set(),
    });
    // dirs sort before files within a level: [nested] precedes a.ts
    expect(summarize(items)).toEqual(["[src/app]", "  [nested]", "    b.ts", "  a.ts"]);
  });

  it("collapsing a folder hides its descendants but keeps the row", () => {
    const { items } = buildDiffFlatItems({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(["src/app/nested"]),
      expandedPaths: new Set(),
    });
    expect(summarize(items)).toEqual(["[src/app]", "  [nested] (collapsed)", "  a.ts"]);
  });

  it("collapsing an ancestor hides everything below it", () => {
    const { items } = buildDiffFlatItems({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(["src/app"]),
      expandedPaths: new Set(),
    });
    expect(summarize(items)).toEqual(["[src/app] (collapsed)"]);
  });

  it("derives sticky indices file-headers-only from the post-collapse list", () => {
    // dirs-first: [src/app], [nested], b.ts, a.ts. Expanding a.ts puts its
    // header at index 3, with the body right after.
    const { items, stickyHeaderIndices } = buildDiffFlatItems({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(),
      expandedPaths: new Set(["src/app/a.ts"]),
    });
    expect(summarize(items)).toEqual([
      "[src/app]",
      "  [nested]",
      "    b.ts",
      "  a.ts",
      "  body:a.ts",
    ]);
    expect(stickyHeaderIndices).toEqual([3]);
    for (const idx of stickyHeaderIndices) {
      expect(items[idx].type).toBe("header");
    }
  });

  it("maps tree file rows back to their original files array index", () => {
    const { items } = buildDiffFlatItems({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(),
      expandedPaths: new Set(),
    });
    // Tree order is b.ts (fileIndex 1) then a.ts (fileIndex 0)
    const headers = items.filter((i) => i.type === "header");
    expect(headers.map((h) => (h.type === "header" ? h.fileIndex : -1))).toEqual([1, 0]);
  });
});

describe("sumHeightsBefore", () => {
  const items = buildDiffFlatItems({
    files: [createFile("src/a.ts"), createFile("src/b.ts")],
    viewMode: "tree",
    collapsedFolders: new Set(),
    expandedPaths: new Set(),
  }).items; // [folder, a.ts, b.ts]

  const heightFor = (item: DiffFlatItem) => (item.type === "folder" ? 10 : 20);

  it("sums the heights of items before the index, counting folder rows", () => {
    expect(sumHeightsBefore(items, 0, heightFor)).toBe(0);
    expect(sumHeightsBefore(items, 1, heightFor)).toBe(10); // folder above a.ts
    expect(sumHeightsBefore(items, 2, heightFor)).toBe(30); // folder + a.ts above b.ts
  });

  it("clamps an out-of-range index to the list length", () => {
    expect(sumHeightsBefore(items, 999, heightFor)).toBe(50);
  });
});

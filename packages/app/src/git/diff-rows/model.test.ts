import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import {
  buildDiffRowIndex,
  createDiffRowCache,
  DIFF_VIRTUALIZATION_CONFIG,
  type DiffRowCache,
} from "./model";

function createFile(path: string, lineCount: number): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: lineCount,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: lineCount,
        lines: [
          { type: "header", content: `@@ -1,0 +1,${lineCount} @@` },
          ...Array.from({ length: lineCount }, (_, index) => ({
            type: "add" as const,
            content: `line ${index + 1}`,
          })),
        ],
      },
    ],
  };
}

function buildIndex(files: ParsedDiffFile[], expandedPaths: string[]) {
  return buildDiffRowIndex({
    files,
    viewMode: "flat",
    collapsedFolders: new Set(),
    expandedPaths: new Set(expandedPaths),
    layout: "unified",
    wrapLines: false,
    lineHeight: 18,
    viewportWidth: 400,
    codeFontSize: 12,
    headerHeightFor: () => 44,
    folderHeight: 44,
    statusHeight: 64,
    measuredGroupHeights: new Map(),
    geometryKey: "test",
    reviewHeightFor: () => 0,
  });
}

function containsReviewedLine(group: {
  lines: Array<{ reviewTarget?: { lineNumber?: number } | null }>;
}): boolean {
  return group.lines.some((line) => line.reviewTarget?.lineNumber === 10);
}

function summarizeTree(items: ReturnType<typeof buildIndex>["items"]): string[] {
  return items.map((item) => {
    if (item.type === "folder") {
      return `${"  ".repeat(item.depth)}[${item.displayName}]${item.collapsed ? " (collapsed)" : ""}`;
    }
    const base = item.file.path.split("/").pop();
    const isGroup = item.type === "unified_group" || item.type === "split_group";
    return `${"  ".repeat(item.depth)}${isGroup ? "group:" : ""}${base}`;
  });
}

describe("buildDiffRowIndex", () => {
  it("turns a large expanded file into bounded native-list cells", () => {
    const index = buildIndex([createFile("large.ts", 1_200)], ["large.ts"]);
    const groups = index.items.filter((item) => item.type === "unified_group");

    expect(groups.length).toBeGreaterThan(1);
    expect(Math.max(...groups.map((group) => group.lines.length))).toBeLessThanOrEqual(
      DIFF_VIRTUALIZATION_CONFIG.groupRowLimit,
    );
    expect(groups.reduce((count, group) => count + group.lines.length, 0)).toBe(1_201);
    expect(index.stickyHeaderIndices).toEqual([0]);
  });

  it("counts wide glyphs and tabs conservatively for horizontal scroll extent", () => {
    for (const [path, content] of [
      ["cjk.ts", "界".repeat(40)],
      ["emoji.ts", "😀".repeat(40)],
      ["tabs.ts", "\t".repeat(10)],
    ]) {
      const file = createFile(path, 1);
      file.hunks[0].lines[1].content = content;

      const index = buildIndex([file], [file.path]);
      const group = index.items.find((item) => item.type === "unified_group");

      expect(group?.contentColumns).toBe(80);
    }
  });

  it("precomputes exact offsets and preserves total file height", () => {
    const index = buildIndex(
      [createFile("first.ts", 65), createFile("second.ts", 1)],
      ["first.ts"],
    );
    const firstGroups = index.items.filter(
      (item) => item.type === "unified_group" && item.file.path === "first.ts",
    );
    const secondHeaderIndex = index.items.findIndex(
      (item) => item.type === "header" && item.file.path === "second.ts",
    );
    const expectedBodyHeight = 66 * 18 + 2;

    expect(firstGroups).toHaveLength(5);
    expect(index.offsetAt(secondHeaderIndex)).toBe(44 + expectedBodyHeight);
    expect(index.offsetOfFile("second.ts")).toBe(44 + expectedBodyHeight);
    expect(index.totalHeight).toBe(44 + expectedBodyHeight + 44);
  });

  it("keeps a review row whole and shifts every later offset by its height", () => {
    const file = createFile("review.ts", 40);
    const baseline = buildIndex([file], [file.path]);
    const reviewed = buildDiffRowIndex({
      files: [file],
      viewMode: "flat",
      collapsedFolders: new Set(),
      expandedPaths: new Set([file.path]),
      layout: "unified",
      wrapLines: false,
      lineHeight: 18,
      viewportWidth: 400,
      codeFontSize: 12,
      headerHeightFor: () => 44,
      folderHeight: 44,
      statusHeight: 64,
      measuredGroupHeights: new Map(),
      geometryKey: "test",
      reviewHeightFor: (target) => (target?.lineNumber === 10 ? 132 : 0),
    });

    expect(reviewed.totalHeight - baseline.totalHeight).toBe(132);
    const reviewGroup = reviewed.items
      .filter((item) => item.type === "unified_group")
      .find(containsReviewedLine);
    expect(reviewGroup).toBeDefined();
    expect(reviewed.heightAt(reviewed.items.indexOf(reviewGroup!))).toBeGreaterThanOrEqual(150);
  });

  it("preserves compressed tree order, indentation, and collapse state", () => {
    const files = [createFile("src/app/a.ts", 1), createFile("src/app/nested/b.ts", 1)];
    const index = buildDiffRowIndex({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(["src/app/nested"]),
      expandedPaths: new Set(["src/app/a.ts"]),
      layout: "unified",
      wrapLines: false,
      lineHeight: 18,
      viewportWidth: 400,
      codeFontSize: 12,
      headerHeightFor: () => 44,
      folderHeight: 44,
      statusHeight: 64,
      measuredGroupHeights: new Map(),
      geometryKey: "tree",
      reviewHeightFor: () => 0,
    });

    expect(summarizeTree(index.items)).toEqual([
      "[src/app]",
      "  [nested] (collapsed)",
      "  a.ts",
      "  group:a.ts",
    ]);
    expect(index.stickyHeaderIndices).toEqual([2]);
  });

  it("keeps split groups bounded and sticky indices on headers", () => {
    const file = createFile("split.ts", 100);
    const index = buildDiffRowIndex({
      files: [file],
      viewMode: "flat",
      collapsedFolders: new Set(),
      expandedPaths: new Set([file.path]),
      layout: "split",
      wrapLines: false,
      lineHeight: 18,
      viewportWidth: 800,
      codeFontSize: 12,
      headerHeightFor: () => 44,
      folderHeight: 44,
      statusHeight: 64,
      measuredGroupHeights: new Map(),
      geometryKey: "split",
      reviewHeightFor: () => 0,
    });
    const groups = index.items.filter((item) => item.type === "split_group");

    expect(Math.max(...groups.map((group) => group.rows.length))).toBeLessThanOrEqual(
      DIFF_VIRTUALIZATION_CONFIG.groupRowLimit,
    );
    expect(index.items[index.stickyHeaderIndices[0]].type).toBe("header");
  });

  it("updates measured group geometry without deriving any file rows again", () => {
    const delegate = createDiffRowCache();
    let derivations = 0;
    const rowCache: DiffRowCache = {
      unifiedFor(file) {
        derivations += 1;
        return delegate.unifiedFor(file);
      },
      splitFor(file) {
        derivations += 1;
        return delegate.splitFor(file);
      },
    };
    const files = [createFile("first.ts", 100), createFile("second.ts", 100)];
    const index = buildDiffRowIndex({
      files,
      viewMode: "flat",
      collapsedFolders: new Set(),
      expandedPaths: new Set(files.map((file) => file.path)),
      layout: "unified",
      wrapLines: true,
      lineHeight: 18,
      viewportWidth: 400,
      codeFontSize: 12,
      headerHeightFor: () => 44,
      folderHeight: 44,
      statusHeight: 64,
      measuredGroupHeights: new Map(),
      geometryKey: "wrap",
      reviewHeightFor: () => 0,
      rowCache,
    });
    const group = index.items.find((item) => item.type === "unified_group");
    expect(group).toBeDefined();
    expect(derivations).toBe(2);

    const groupIndex = index.indexOfGroup(group!.key);
    const laterOffset = index.offsetAt(groupIndex + 1);
    const update = index.updateHeight(group!.key, index.heightAt(groupIndex) + 20);

    expect(update?.delta).toBe(20);
    expect(index.offsetAt(groupIndex + 1)).toBe(laterOffset + 20);
    expect(derivations).toBe(2);
  });

  it("uses the key's rounded viewport width for wrapped group membership", () => {
    const file = createFile("wrapped.ts", 40);
    for (const line of file.hunks[0].lines) {
      if (line.type !== "header") {
        line.content = "x".repeat(88);
      }
    }
    const buildWrapped = (viewportWidth: number) =>
      buildDiffRowIndex({
        files: [file],
        viewMode: "flat",
        collapsedFolders: new Set(),
        expandedPaths: new Set([file.path]),
        layout: "unified",
        wrapLines: true,
        lineHeight: 18,
        viewportWidth,
        codeFontSize: 12,
        headerHeightFor: () => 44,
        folderHeight: 44,
        statusHeight: 64,
        measuredGroupHeights: new Map(),
        geometryKey: `wrap:${Math.round(viewportWidth)}`,
        reviewHeightFor: () => 0,
      });
    const summarizeGroups = (viewportWidth: number) =>
      buildWrapped(viewportWidth)
        .items.filter((item) => item.type === "unified_group")
        .map((group) => ({
          key: group.key,
          startRowIndex: group.startRowIndex,
          lineCount: group.lines.length,
        }));

    expect(summarizeGroups(399.2)).toEqual(summarizeGroups(399.49));
  });
});

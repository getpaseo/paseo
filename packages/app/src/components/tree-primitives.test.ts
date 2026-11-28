import { describe, expect, it } from "vitest";
import {
  treeIndentGuideOffsets,
  treeRowPaddingLeft,
  TREE_INDENT_PER_LEVEL,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";

describe("treeIndentGuideOffsets", () => {
  it("indents each level by 16px", () => {
    expect(TREE_INDENT_PER_LEVEL).toBe(16);
    expect(treeRowPaddingLeft(2) - treeRowPaddingLeft(1)).toBe(16);
  });

  it("draws no guide for a root row", () => {
    expect(treeIndentGuideOffsets(0)).toEqual([]);
  });

  it("centres one 1px guide under each ancestor's chevron", () => {
    const chevronCenter = (level: number) =>
      treeRowPaddingLeft(level) + WORKSPACE_TREE_ICON_SIZE / 2;

    expect(treeIndentGuideOffsets(3).map((left) => left + 0.5)).toEqual([
      chevronCenter(0),
      chevronCenter(1),
      chevronCenter(2),
    ]);
  });
});

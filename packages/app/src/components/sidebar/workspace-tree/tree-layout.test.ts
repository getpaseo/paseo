import { describe, expect, it } from "vitest";
import {
  resolveTreeRowIndent,
  TREE_CHEVRON_SLOT_WIDTH,
  TREE_INDENT_PER_DEPTH,
  TREE_MAX_INDENT_DEPTH,
  TREE_ROOT_DEPTH,
} from "./tree-layout";

/**
 * The left edge of a row's icon, given its depth. The chevron column is
 * reserved on every row — expandable or not — so it is a constant term here
 * rather than something that depends on whether the row has children.
 */
function iconLeftOffset(depth: number): number {
  return resolveTreeRowIndent(depth) + TREE_CHEVRON_SLOT_WIDTH;
}

describe("workspace tree alignment", () => {
  it("puts a workspace's direct children flush against the chevron column", () => {
    // Top-level agents and terminals both render at the root depth, so this one
    // offset is the column both of them land in.
    expect(resolveTreeRowIndent(TREE_ROOT_DEPTH)).toBe(0);
    expect(iconLeftOffset(TREE_ROOT_DEPTH)).toBe(TREE_CHEVRON_SLOT_WIDTH);
  });

  it("does not depend on whether a row is expandable", () => {
    // Expandability changes what fills the chevron slot, never its width, so
    // the icon offset is a function of depth alone.
    for (const depth of [0, 1, 2, 3]) {
      expect(iconLeftOffset(depth)).toBe(resolveTreeRowIndent(depth) + TREE_CHEVRON_SLOT_WIDTH);
    }
  });

  it("indents one step per nesting level", () => {
    expect(resolveTreeRowIndent(1)).toBe(TREE_INDENT_PER_DEPTH);
    expect(resolveTreeRowIndent(2)).toBe(2 * TREE_INDENT_PER_DEPTH);
    expect(resolveTreeRowIndent(3)).toBe(3 * TREE_INDENT_PER_DEPTH);
  });

  it("clamps indentation so deep chains keep a readable label", () => {
    const clamped = TREE_MAX_INDENT_DEPTH * TREE_INDENT_PER_DEPTH;
    expect(resolveTreeRowIndent(TREE_MAX_INDENT_DEPTH)).toBe(clamped);
    expect(resolveTreeRowIndent(TREE_MAX_INDENT_DEPTH + 1)).toBe(clamped);
    expect(resolveTreeRowIndent(99)).toBe(clamped);
  });

  it("treats malformed depths as the root and clamps unbounded ones", () => {
    expect(resolveTreeRowIndent(-1)).toBe(0);
    expect(resolveTreeRowIndent(Number.NaN)).toBe(0);
    expect(resolveTreeRowIndent(Number.POSITIVE_INFINITY)).toBe(
      TREE_MAX_INDENT_DEPTH * TREE_INDENT_PER_DEPTH,
    );
  });
});

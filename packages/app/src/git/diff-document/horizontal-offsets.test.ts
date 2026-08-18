import { describe, expect, it } from "vitest";
import {
  horizontalOffsetForPath,
  retainHorizontalOffsetMapForPaths,
  retainHorizontalOffsetsForPaths,
} from "./horizontal-offsets";

describe("native diff horizontal offsets", () => {
  it("retains independent offsets by path through reorder, removal, insertion, and re-addition", () => {
    const initial = { "src/a.ts": 120, "src/b.ts": 340 };
    const reordered = retainHorizontalOffsetsForPaths(initial, ["src/b.ts", "src/a.ts"]);
    expect(horizontalOffsetForPath(reordered, "src/a.ts")).toBe(120);
    expect(horizontalOffsetForPath(reordered, "src/b.ts")).toBe(340);

    const removed = retainHorizontalOffsetsForPaths(reordered, ["src/b.ts"]);
    const inserted = retainHorizontalOffsetsForPaths(removed, ["src/new.ts", "src/b.ts"]);
    expect(horizontalOffsetForPath(inserted, "src/new.ts")).toBe(0);
    expect(horizontalOffsetForPath(inserted, "src/b.ts")).toBe(340);

    const readded = retainHorizontalOffsetsForPaths(inserted, [
      "src/a.ts",
      "src/new.ts",
      "src/b.ts",
    ]);
    expect(horizontalOffsetForPath(readded, "src/a.ts")).toBe(0);
    expect(horizontalOffsetForPath(readded, "src/new.ts")).toBe(0);
    expect(horizontalOffsetForPath(readded, "src/b.ts")).toBe(340);
  });
});

describe("web diff horizontal offsets", () => {
  it("forgets removed paths before they are reintroduced", () => {
    const initial = new Map([
      ["src/collapsed.ts", 120],
      ["src/offscreen.ts", 340],
      ["src/removed.ts", 560],
    ]);

    const afterRemoval = retainHorizontalOffsetMapForPaths(initial, [
      "src/collapsed.ts",
      "src/offscreen.ts",
    ]);
    expect([...afterRemoval]).toEqual([
      ["src/collapsed.ts", 120],
      ["src/offscreen.ts", 340],
    ]);

    const afterReintroduction = retainHorizontalOffsetMapForPaths(afterRemoval, [
      "src/removed.ts",
      "src/offscreen.ts",
      "src/collapsed.ts",
    ]);
    expect([...afterReintroduction]).toEqual([
      ["src/offscreen.ts", 340],
      ["src/collapsed.ts", 120],
    ]);
    expect(afterReintroduction.get("src/removed.ts") ?? 0).toBe(0);
  });
});

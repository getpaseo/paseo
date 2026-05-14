import { describe, expect, test } from "vitest";

import { areEquivalentPaths, createPathEquivalenceMatcher } from "./path.js";

describe("path equivalence", () => {
  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });
});

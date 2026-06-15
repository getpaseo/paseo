import { describe, expect, it } from "vitest";
import { dropFailedExpandedPaths } from "./use-file-explorer-actions";

describe("dropFailedExpandedPaths", () => {
  it("returns a copy of the input when nothing failed", () => {
    const input = [".", "src", "src/utils"];
    const result = dropFailedExpandedPaths(input, new Set());
    expect(result).toEqual([".", "src", "src/utils"]);
    expect(result).not.toBe(input);
  });

  it("removes failed paths and keeps survivors plus '.'", () => {
    expect(
      dropFailedExpandedPaths([".", "vendor", "src", "src/utils"], new Set(["vendor"])),
    ).toEqual([".", "src", "src/utils"]);
  });

  it("removes multiple failed paths in a nested tree", () => {
    expect(
      dropFailedExpandedPaths(
        [".", "a/b", "vendor/foo", "vendor/bar", "src"],
        new Set(["vendor/foo", "vendor/bar"]),
      ),
    ).toEqual([".", "a/b", "src"]);
  });

  it("ignores failures that are not in the current list", () => {
    expect(dropFailedExpandedPaths([".", "src"], new Set(["does-not-exist"]))).toEqual([
      ".",
      "src",
    ]);
  });
});

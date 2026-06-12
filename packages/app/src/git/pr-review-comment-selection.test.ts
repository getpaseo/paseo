import { describe, expect, it } from "vitest";
import {
  isFileFullySelected,
  pruneSelectionToExisting,
  selectionsAreEqual,
  toggleFileSelection,
  toggleThreadSelection,
} from "./pr-review-comment-selection";

describe("toggleThreadSelection", () => {
  it("adds an unselected thread", () => {
    expect([...toggleThreadSelection(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
  });

  it("removes a selected thread", () => {
    expect([...toggleThreadSelection(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a"]);
    toggleThreadSelection(input, "b");
    expect([...input]).toEqual(["a"]);
  });
});

describe("isFileFullySelected", () => {
  it("is true only when every file thread is selected", () => {
    expect(isFileFullySelected(new Set(["a", "b"]), ["a", "b"])).toBe(true);
    expect(isFileFullySelected(new Set(["a"]), ["a", "b"])).toBe(false);
  });

  it("is false for an empty file group", () => {
    expect(isFileFullySelected(new Set(["a"]), [])).toBe(false);
  });
});

describe("toggleFileSelection", () => {
  it("selects all file threads when not fully selected", () => {
    expect([...toggleFileSelection(new Set(["a"]), ["a", "b", "c"])].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("clears all file threads when fully selected, leaving others", () => {
    expect([...toggleFileSelection(new Set(["a", "b", "x"]), ["a", "b"])]).toEqual(["x"]);
  });
});

describe("pruneSelectionToExisting", () => {
  it("drops selections for threads that no longer exist", () => {
    expect([...pruneSelectionToExisting(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["a"]);
  });

  it("returns an empty set when nothing survives", () => {
    expect([...pruneSelectionToExisting(new Set(["gone"]), ["a"])]).toEqual([]);
  });
});

describe("selectionsAreEqual", () => {
  it("compares set membership regardless of insertion order", () => {
    expect(selectionsAreEqual(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(selectionsAreEqual(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  groupStartAnchor,
  hasVisibleOrderChanged,
  mergeWithRemainder,
  moveKeyRelative,
  spliceReorderedKeys,
} from "./sidebar-reorder";

describe("hasVisibleOrderChanged", () => {
  it("returns false when visible order is unchanged", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["a", "b", "c"],
      }),
    ).toBe(false);
  });

  it("returns true when visible items are reordered", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["b", "a", "c"],
      }),
    ).toBe(true);
  });

  it("returns true when a visible key is missing from current order", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b"],
        reorderedVisibleKeys: ["a", "c"],
      }),
    ).toBe(true);
  });
});

describe("mergeWithRemainder", () => {
  it("appends non-visible stored keys after reordered visible keys", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["a", "x", "b", "y"],
        reorderedVisibleKeys: ["b", "a"],
      }),
    ).toEqual(["b", "a", "x", "y"]);
  });

  it("keeps unknown current keys when no visible keys are reordered", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["stale", "hidden"],
        reorderedVisibleKeys: [],
      }),
    ).toEqual(["stale", "hidden"]);
  });
});

describe("spliceReorderedKeys", () => {
  it("keeps reordered members in their original slots (does not front-load them)", () => {
    expect(
      spliceReorderedKeys({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["d", "b"],
      }),
    ).toEqual(["a", "d", "c", "b"]);
  });

  it("returns current order unchanged when the reordered subset keeps the same order", () => {
    expect(
      spliceReorderedKeys({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["b", "d"],
      }),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("appends reordered keys that are not present in current order", () => {
    expect(
      spliceReorderedKeys({
        currentOrder: ["a", "b", "c"],
        reorderedVisibleKeys: ["c", "a", "new"],
      }),
    ).toEqual(["c", "b", "a", "new"]);
  });

  it("leaves current order untouched when no keys are reordered", () => {
    expect(
      spliceReorderedKeys({
        currentOrder: ["a", "b", "c"],
        reorderedVisibleKeys: [],
      }),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("moveKeyRelative", () => {
  it("moves the key before the anchor", () => {
    expect(
      moveKeyRelative({
        currentOrder: ["a", "b", "c", "d"],
        key: "d",
        anchorKey: "b",
        placement: "before",
      }),
    ).toEqual(["a", "d", "b", "c"]);
  });

  it("moves the key after the anchor", () => {
    expect(
      moveKeyRelative({
        currentOrder: ["a", "b", "c", "d"],
        key: "a",
        anchorKey: "b",
        placement: "after",
      }),
    ).toEqual(["b", "a", "c", "d"]);
  });

  it("appends the key at the end when the anchor is missing", () => {
    expect(
      moveKeyRelative({
        currentOrder: ["a", "b", "c"],
        key: "b",
        anchorKey: "missing",
        placement: "before",
      }),
    ).toEqual(["a", "c", "b"]);
  });

  it("still inserts the key when it is missing from current order", () => {
    expect(
      moveKeyRelative({
        currentOrder: ["a", "b", "c"],
        key: "new",
        anchorKey: "b",
        placement: "after",
      }),
    ).toEqual(["a", "b", "new", "c"]);
  });

  it("returns the order unchanged when key equals anchor", () => {
    const currentOrder = ["a", "b", "c"];
    expect(
      moveKeyRelative({ currentOrder, key: "b", anchorKey: "b", placement: "before" }),
    ).toEqual(["a", "b", "c"]);
  });

  it("moves the key to the first position", () => {
    expect(
      moveKeyRelative({
        currentOrder: ["a", "b", "c"],
        key: "c",
        anchorKey: "a",
        placement: "before",
      }),
    ).toEqual(["c", "a", "b"]);
  });

  it("moves the key to the last position", () => {
    expect(
      moveKeyRelative({
        currentOrder: ["a", "b", "c"],
        key: "a",
        anchorKey: "c",
        placement: "after",
      }),
    ).toEqual(["b", "c", "a"]);
  });
});

describe("groupStartAnchor", () => {
  it("is the group's first row when nothing is arriving", () => {
    expect(
      groupStartAnchor({
        currentOrder: ["a", "x", "b"],
        firstViewKey: "x",
        arrivingKeys: new Set(),
      }),
    ).toBe("x");
  });

  it("is the earliest arriving row when one already sits ahead of the first row", () => {
    expect(
      groupStartAnchor({
        currentOrder: ["a", "x", "b"],
        firstViewKey: "x",
        arrivingKeys: new Set(["a"]),
      }),
    ).toBe("a");
  });

  it("falls back to the first row when neither is in the order", () => {
    expect(
      groupStartAnchor({ currentOrder: ["b"], firstViewKey: "x", arrivingKeys: new Set(["a"]) }),
    ).toBe("x");
  });
});

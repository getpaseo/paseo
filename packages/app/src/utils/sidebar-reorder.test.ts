import { describe, expect, it } from "vitest";

import {
  hasVisibleOrderChanged,
  mergeVisibleReorderInPlace,
  mergeWithRemainder,
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

describe("mergeVisibleReorderInPlace", () => {
  it("refills the visible slots in the new order and leaves the rest alone", () => {
    expect(
      mergeVisibleReorderInPlace({
        currentOrder: ["a", "x", "b", "y"],
        reorderedVisibleKeys: ["b", "a"],
      }),
    ).toEqual(["b", "x", "a", "y"]);
  });

  it("does not disturb a section it does not touch", () => {
    // A project shared across hosts has one global slot, so reordering the
    // other section must keep this section's relative order.
    expect(
      mergeVisibleReorderInPlace({
        currentOrder: ["p1", "shared", "p3"],
        reorderedVisibleKeys: ["p3", "shared"],
      }),
    ).toEqual(["p1", "p3", "shared"]);
  });

  it("appends visible keys that are not yet in the order", () => {
    expect(
      mergeVisibleReorderInPlace({
        currentOrder: ["a", "b"],
        reorderedVisibleKeys: ["c", "a"],
      }),
    ).toEqual(["c", "b", "a"]);
  });
});

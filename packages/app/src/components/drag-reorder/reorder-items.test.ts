import { describe, expect, it } from "vitest";
import { reorderItemsOnDragEnd } from "./reorder-items";

const items = ["alpha", "beta", "gamma"];
const byValue = (item: string): string => item;

describe("reorderItemsOnDragEnd", () => {
  it("moves the active item to the over position", () => {
    expect(
      reorderItemsOnDragEnd({
        items,
        activeId: "alpha",
        overId: "gamma",
        keyExtractor: byValue,
      }),
    ).toEqual(["beta", "gamma", "alpha"]);
  });

  it("is a no-op when the drop target is missing", () => {
    expect(
      reorderItemsOnDragEnd({
        items,
        activeId: "alpha",
        overId: null,
        keyExtractor: byValue,
      }),
    ).toBeNull();
  });

  it("is a no-op when the active and over items are the same", () => {
    expect(
      reorderItemsOnDragEnd({
        items,
        activeId: "beta",
        overId: "beta",
        keyExtractor: byValue,
      }),
    ).toBeNull();
  });

  it("is a no-op when the active id is not in the list", () => {
    expect(
      reorderItemsOnDragEnd({
        items,
        activeId: "delta",
        overId: "beta",
        keyExtractor: byValue,
      }),
    ).toBeNull();
  });

  it("is a no-op when the over id is not in the list", () => {
    expect(
      reorderItemsOnDragEnd({
        items,
        activeId: "alpha",
        overId: "delta",
        keyExtractor: byValue,
      }),
    ).toBeNull();
  });
});

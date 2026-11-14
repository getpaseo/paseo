import { describe, expect, it } from "vitest";
import { orderDroppedItems } from "./draggable-list-drop-order";

interface Row {
  key: string;
}

const rows = (...keys: string[]): Row[] => keys.map((key) => ({ key }));
const keyExtractor = (row: Row) => row.key;

describe("orderDroppedItems", () => {
  it("returns the rows in the order the list shows at the drop", () => {
    const result = orderDroppedItems({
      data: rows("a", "b", "c"),
      keyExtractor,
      indexToKey: ["c", "a", "b"],
    });

    expect(result.map(keyExtractor)).toEqual(["c", "a", "b"]);
  });

  it("leaves out a row that disappeared while it was dropped", () => {
    const result = orderDroppedItems({
      data: rows("a", "c"),
      keyExtractor,
      indexToKey: ["c", "b", "a"],
    });

    expect(result).toEqual(rows("c", "a"));
  });

  it("leaves out a row that arrived while it was dropped, so its stored place is kept", () => {
    const result = orderDroppedItems({
      data: rows("a", "b", "new"),
      keyExtractor,
      indexToKey: ["b", "a"],
    });

    expect(result).toEqual(rows("b", "a"));
  });
});

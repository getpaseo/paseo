import { describe, expect, it } from "vitest";
import { movedItemKey } from "./native-drop";

const byValue = (item: string): string => item;

describe("movedItemKey", () => {
  it("names the item at its new slot", () => {
    expect(movedItemKey({ data: ["b", "c", "a"], from: 0, to: 2 }, byValue)).toBe("a");
  });

  it("names nothing when the item is released in the slot it started in", () => {
    expect(movedItemKey({ data: ["a", "b", "c"], from: 1, to: 1 }, byValue)).toBeNull();
  });
});

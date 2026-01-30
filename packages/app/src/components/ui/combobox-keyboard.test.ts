import { describe, expect, it } from "vitest";

import { getNextActiveIndex } from "./combobox-keyboard";

describe("getNextActiveIndex", () => {
  it("returns -1 when itemCount is 0", () => {
    expect(
      getNextActiveIndex({ currentIndex: 0, itemCount: 0, key: "ArrowDown" })
    ).toBe(-1);
  });

  it("starts at 0 on ArrowDown when no active item", () => {
    expect(
      getNextActiveIndex({ currentIndex: -1, itemCount: 3, key: "ArrowDown" })
    ).toBe(0);
  });

  it("starts at last on ArrowUp when no active item", () => {
    expect(
      getNextActiveIndex({ currentIndex: -1, itemCount: 3, key: "ArrowUp" })
    ).toBe(2);
  });

  it("wraps around on ArrowDown and ArrowUp", () => {
    expect(
      getNextActiveIndex({ currentIndex: 2, itemCount: 3, key: "ArrowDown" })
    ).toBe(0);
    expect(
      getNextActiveIndex({ currentIndex: 0, itemCount: 3, key: "ArrowUp" })
    ).toBe(2);
  });
});


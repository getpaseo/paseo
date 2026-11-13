import { describe, expect, it } from "vitest";
import { needsSeparator, withDrawn, withoutDrawn } from "./line";

describe("row badge line", () => {
  it("separates an item only from something drawn before it", () => {
    // Item 0 returned null or threw, so only item 1 draws and nothing precedes it.
    const drawn = withDrawn([], 1);
    expect(needsSeparator({ leading: false, position: 1, drawn })).toBe(false);
  });

  it("separates the second drawn item from the first", () => {
    const drawn = withDrawn(withDrawn([], 0), 2);
    expect(needsSeparator({ leading: false, position: 2, drawn })).toBe(true);
    expect(needsSeparator({ leading: false, position: 0, drawn })).toBe(false);
  });

  it("separates the first drawn item when the row drew items of its own", () => {
    expect(needsSeparator({ leading: true, position: 0, drawn: withDrawn([], 0) })).toBe(true);
  });

  it("forgets an item that stops drawing", () => {
    expect(withoutDrawn(withDrawn(withDrawn([], 0), 1), 0)).toEqual([1]);
  });
});

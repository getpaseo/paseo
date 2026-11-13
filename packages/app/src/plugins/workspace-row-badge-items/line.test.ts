import { describe, expect, it } from "vitest";
import { createRowBadgeLine, needsSeparator } from "./line";

describe("row badge line", () => {
  it("separates an item only from something drawn before it", () => {
    const line = createRowBadgeLine();
    // Item 0 returned null or threw, so only item 1 draws and nothing precedes it.
    line.markDrawn(1);
    expect(needsSeparator({ leading: false, position: 1, drawn: line.getDrawn() })).toBe(false);
  });

  it("separates the second drawn item from the first", () => {
    const line = createRowBadgeLine();
    line.markDrawn(0);
    line.markDrawn(2);
    expect(needsSeparator({ leading: false, position: 2, drawn: line.getDrawn() })).toBe(true);
    expect(needsSeparator({ leading: false, position: 0, drawn: line.getDrawn() })).toBe(false);
  });

  it("separates the first drawn item when the row drew items of its own", () => {
    const line = createRowBadgeLine();
    line.markDrawn(0);
    expect(needsSeparator({ leading: true, position: 0, drawn: line.getDrawn() })).toBe(true);
  });

  it("forgets an item that stops drawing and tells subscribers", () => {
    const line = createRowBadgeLine();
    let notified = 0;
    line.subscribe(() => {
      notified += 1;
    });
    const unmark = line.markDrawn(0);
    unmark();
    expect(line.getDrawn()).toEqual([]);
    expect(notified).toBe(2);
  });
});

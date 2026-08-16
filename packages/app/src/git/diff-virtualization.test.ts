import { describe, expect, it } from "vitest";
import { createDiffRowWindow } from "./diff-virtualization";

describe("createDiffRowWindow", () => {
  it("renders only the viewport and overscan while preserving the full height", () => {
    const rows = Array.from({ length: 1_200 }, () => 18);
    const window = createDiffRowWindow(rows, {
      viewportTop: 0,
      viewportHeight: 900,
      overscan: 900,
    });

    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(100);
    expect(window.beforeHeight).toBe(0);
    expect(window.afterHeight).toBe(19_800);
    expect(window.beforeHeight + window.renderedHeight + window.afterHeight).toBe(21_600);
  });

  it("finds a deep variable-height window without replaying earlier rows", () => {
    const rows = [18, 18, 90, 18, 150, 18, 18];
    const window = createDiffRowWindow(rows, {
      viewportTop: 120,
      viewportHeight: 60,
      overscan: 0,
    });

    expect(window).toEqual({
      startIndex: 2,
      endIndex: 5,
      beforeHeight: 36,
      renderedHeight: 258,
      afterHeight: 36,
      totalHeight: 330,
    });
  });

  it("returns an empty row window when an overscanned body is still offscreen", () => {
    const window = createDiffRowWindow([18, 18, 18], {
      viewportTop: -2_000,
      viewportHeight: 800,
      overscan: 600,
    });

    expect(window).toEqual({
      startIndex: 0,
      endIndex: 0,
      beforeHeight: 0,
      renderedHeight: 0,
      afterHeight: 54,
      totalHeight: 54,
    });
  });
});

import { describe, expect, it } from "vitest";
import { computePosition, getTransformOrigin, type Rect } from "./menu-anchor";

const DISPLAY: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const TRIGGER: Rect = { x: 100, y: 100, width: 40, height: 20 };
const CONTENT = { width: 200, height: 100 };

function position(overrides: Partial<Parameters<typeof computePosition>[0]> = {}) {
  return computePosition({
    triggerRect: TRIGGER,
    contentSize: CONTENT,
    displayArea: DISPLAY,
    placement: "bottom",
    alignment: "start",
    offset: 4,
    ...overrides,
  });
}

describe("computePosition", () => {
  it("sits below the trigger with room to spare", () => {
    expect(position()).toEqual({ x: 100, y: 124, actualPlacement: "bottom" });
  });

  it("aligns to the trigger's start, center, and end edges", () => {
    expect(position({ alignment: "start" }).x).toBe(100);
    expect(position({ alignment: "center" }).x).toBe(20);
    // 100 + 40 - 200 = -60, pulled back to the edge padding.
    expect(position({ alignment: "end" }).x).toBe(8);
  });

  it("flips above the trigger when it does not fit below and there is more room above", () => {
    const result = position({
      triggerRect: { ...TRIGGER, y: 700 },
      contentSize: { width: 200, height: 200 },
    });
    expect(result.actualPlacement).toBe("top");
    expect(result.y).toBe(496);
  });

  it("stays put when flipping would be just as cramped", () => {
    // Taller than the whole display area: neither side fits, so flipping buys nothing.
    const result = position({
      displayArea: { x: 0, y: 0, width: 1000, height: 300 },
      contentSize: { width: 200, height: 400 },
    });
    expect(result.actualPlacement).toBe("bottom");
  });

  it("places side placements flush with the trigger top and ignores alignment", () => {
    // Mid-display trigger so both sides fit and neither placement flips; this case is
    // about the vertical edge and alignment, not about which side wins.
    const centred = { ...TRIGGER, x: 400 };

    const left = position({ placement: "left", alignment: "end", triggerRect: centred });
    expect(left).toEqual({ x: 196, y: 100, actualPlacement: "left" });

    const right = position({ placement: "right", alignment: "end", triggerRect: centred });
    expect(right).toEqual({ x: 444, y: 100, actualPlacement: "right" });
  });

  // A submenu opens to the right. Anchored near the right edge there is nowhere to put it,
  // and clamping alone drags it back over the row that opened it.
  it("flips a side placement to the other side when its own side has no room", () => {
    const result = position({
      placement: "right",
      triggerRect: { ...TRIGGER, x: 900 },
    });
    expect(result.actualPlacement).toBe("left");
    expect(result.x).toBe(696);
  });

  it("stays put when the other side is just as cramped", () => {
    // Wider than the whole display area: flipping only moves the clipping.
    const result = position({
      placement: "right",
      displayArea: { x: 0, y: 0, width: 300, height: 800 },
      contentSize: { width: 400, height: 100 },
    });
    expect(result.actualPlacement).toBe("right");
  });

  it("keeps the surface inside a display area that does not start at the origin", () => {
    // Regression: the horizontal clamp used to ignore displayArea.x while the vertical one
    // honoured displayArea.y, so an offset display area pushed the surface off its left edge.
    const result = position({
      displayArea: { x: 100, y: 0, width: 900, height: 800 },
      alignment: "end",
    });
    expect(result.x).toBe(108);
  });
});

describe("getTransformOrigin", () => {
  it.each([
    ["bottom", "start", "left top"],
    ["top", "end", "right bottom"],
    ["right", "center", "center center"],
  ] as const)("maps %s/%s to %s", (placement, alignment, expected) => {
    expect(getTransformOrigin(placement, alignment)).toBe(expected);
  });
});

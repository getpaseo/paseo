import { describe, expect, it } from "vitest";
import { reviewBackgroundPaint, reviewDividerHeight, reviewGapTop } from "./review-paint";

describe("native diff review painting", () => {
  it("paints review space with the surface paint and continues the gutter divider", () => {
    const surface = { name: "surface" };
    const border = { name: "border" };
    expect(reviewBackgroundPaint(surface)).toBe(surface);
    expect(reviewBackgroundPaint(surface)).not.toBe(border);
    expect(reviewGapTop(0, 58, 40)).toBe(18);
    expect(reviewDividerHeight(58)).toBe(58);
  });
});

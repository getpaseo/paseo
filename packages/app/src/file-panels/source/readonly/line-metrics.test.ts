import { describe, expect, it } from "vitest";
import { sourceLineMetrics } from "./line-metrics";

describe("native source line metrics", () => {
  it("keeps the Appearance size at 100%", () => {
    expect(sourceLineMetrics(12, 1)).toEqual({ fontSize: 12, lineHeight: 17, gutterWidth: 56 });
  });

  it("scales the text, the row and the line-number column together", () => {
    const zoomed = sourceLineMetrics(12, 2);
    expect(zoomed).toEqual({ fontSize: 24, lineHeight: 35, gutterWidth: 112 });
    expect(zoomed.gutterWidth / zoomed.fontSize).toBe(56 / 12);
  });
});

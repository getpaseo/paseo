import { describe, expect, it } from "vitest";
import {
  acceptTreeRailContainerMeasurement,
  resolveVisibleTreeRailWidth,
} from "@/components/tree-rail-layout";

describe("tree rail layout", () => {
  it("keeps the last usable geometry while a retained panel is hidden", () => {
    const visibleContainerWidth = 900;
    const hiddenContainerWidth = acceptTreeRailContainerMeasurement(visibleContainerWidth, 0);

    expect(hiddenContainerWidth).toBe(visibleContainerWidth);
    expect(resolveVisibleTreeRailWidth(420, hiddenContainerWidth)).toBe(420);
  });

  it("clamps the rail after a usable narrow-container measurement", () => {
    const containerWidth = acceptTreeRailContainerMeasurement(900, 500);

    expect(resolveVisibleTreeRailWidth(420, containerWidth)).toBe(260);
  });
});

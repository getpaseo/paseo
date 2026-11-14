import { describe, expect, it } from "vitest";
import { fitContentSize } from "@/components/zoomable-viewport/geometry";
import { getDiagramFit, getDiagramPreviewHeight } from "./presentation";

describe("diagram preview sizing", () => {
  it("adds the frame padding to the preview box so a short diagram still fits", () => {
    const fit = getDiagramFit({}, { padding: 48 });
    const boxHeight = getDiagramPreviewHeight(40, fit);
    expect(boxHeight).toBe(136);

    const fitted = fitContentSize(
      { width: 200, height: 40 },
      { width: 400, height: boxHeight },
      fit,
    );
    expect(fitted).toEqual({ width: 200, height: 40 });
  });

  it("uses the diagram height when the frame adds no padding", () => {
    expect(getDiagramPreviewHeight(120, undefined)).toBe(120);
    expect(getDiagramPreviewHeight(120, getDiagramFit({}, undefined))).toBe(120);
  });
});

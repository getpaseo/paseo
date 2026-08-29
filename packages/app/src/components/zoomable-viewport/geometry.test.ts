import { describe, expect, it } from "vitest";
import {
  FIT_TRANSFORM,
  clampTransform,
  fitContentSize,
  panContent,
  zoomContentAtPoint,
} from "./geometry";

const viewport = { width: 800, height: 600 };
const fittedContent = { width: 800, height: 400 };

describe("zoomable viewport geometry", () => {
  it("fits content inside the viewport without changing its aspect ratio", () => {
    expect(fitContentSize({ width: 1600, height: 800 }, viewport)).toEqual(fittedContent);
    expect(fitContentSize({ width: 400, height: 800 }, viewport)).toEqual({
      width: 300,
      height: 600,
    });
  });

  it("returns to the centered fit transform at the minimum scale", () => {
    expect(
      clampTransform({ scale: 0.5, x: 200, y: -200 }, fittedContent, viewport, {
        minScale: 1,
        maxScale: 8,
      }),
    ).toEqual(FIT_TRANSFORM);
  });

  it("keeps the focal content point under the cursor while zooming", () => {
    expect(
      zoomContentAtPoint({
        transform: FIT_TRANSFORM,
        scale: 2,
        focalPoint: { x: 600, y: 300 },
        fittedContent,
        viewport,
        limits: { minScale: 1, maxScale: 8 },
      }),
    ).toEqual({ scale: 2, x: -200, y: 0 });
  });

  it("clamps panning to the scaled content edges", () => {
    expect(
      panContent({
        transform: { scale: 2, x: 0, y: 0 },
        delta: { x: 900, y: -900 },
        fittedContent,
        viewport,
        limits: { minScale: 1, maxScale: 8 },
      }),
    ).toEqual({ scale: 2, x: 400, y: -100 });
  });

  it("allows Mermaid consumers to zoom below fit without inventing translation", () => {
    expect(
      clampTransform({ scale: 0.25, x: 100, y: 100 }, fittedContent, viewport, {
        minScale: 0.25,
        maxScale: 8,
      }),
    ).toEqual({ scale: 0.25, x: 0, y: 0 });
  });
});

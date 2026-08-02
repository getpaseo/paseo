import { describe, expect, it } from "vitest";
import {
  FIT_IMAGE_TRANSFORM,
  IMAGE_ZOOM_STEP,
  MAX_IMAGE_ZOOM,
  clampImageTransform,
  clampImageZoom,
  fitImageSize,
  panImage,
  zoomImageAtPoint,
} from "./transform";

const viewport = { width: 800, height: 600 };

describe("image file preview transform", () => {
  it("fits landscape, portrait, and small images into the viewport", () => {
    expect(fitImageSize({ width: 1600, height: 900 }, viewport)).toEqual({
      width: 800,
      height: 450,
    });
    expect(fitImageSize({ width: 600, height: 1200 }, viewport)).toEqual({
      width: 300,
      height: 600,
    });
    expect(fitImageSize({ width: 400, height: 300 }, viewport)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("keeps the viewport center fixed when zooming from the center", () => {
    expect(
      zoomImageAtPoint({
        transform: FIT_IMAGE_TRANSFORM,
        zoom: 2,
        focalPoint: { x: 400, y: 300 },
        fittedImage: { width: 800, height: 450 },
        viewport,
      }),
    ).toEqual({ zoom: 2, x: 0, y: 0 });
  });

  it("keeps an arbitrary image point under the focal point while zooming", () => {
    expect(
      zoomImageAtPoint({
        transform: FIT_IMAGE_TRANSFORM,
        zoom: 2,
        focalPoint: { x: 600, y: 300 },
        fittedImage: { width: 800, height: 600 },
        viewport,
      }),
    ).toEqual({ zoom: 2, x: -200, y: 0 });
  });

  it("uses a quarter-step button increment and clamps zoom to one through four", () => {
    expect(IMAGE_ZOOM_STEP).toBe(0.25);
    expect(clampImageZoom(0.5)).toBe(1);
    expect(clampImageZoom(2.5)).toBe(2.5);
    expect(clampImageZoom(10)).toBe(MAX_IMAGE_ZOOM);
  });

  it("returns to the centered fitted transform at one-times zoom", () => {
    expect(
      clampImageTransform({ zoom: 1, x: 120, y: -80 }, { width: 800, height: 450 }, viewport),
    ).toBe(FIT_IMAGE_TRANSFORM);
  });

  it("clamps horizontal and vertical panning to visible image bounds", () => {
    expect(
      panImage({
        transform: { zoom: 2, x: 0, y: 0 },
        delta: { x: 1000, y: -1000 },
        fittedImage: { width: 800, height: 450 },
        viewport,
      }),
    ).toEqual({ zoom: 2, x: 400, y: -150 });
  });

  it("keeps a letterboxed axis centered until zoomed content exceeds the viewport", () => {
    expect(
      panImage({
        transform: { zoom: 1.25, x: 0, y: 0 },
        delta: { x: 100, y: 100 },
        fittedImage: { width: 300, height: 600 },
        viewport,
      }),
    ).toEqual({ zoom: 1.25, x: 0, y: 75 });
  });
});

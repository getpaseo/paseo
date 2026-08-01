import { describe, expect, it } from "vitest";
import { getContainedPanBounds, getFocalTranslation } from "./zoomable-image-geometry";

describe("getContainedPanBounds", () => {
  it("uses the rendered portrait image instead of viewport letterbox space", () => {
    const input = {
      viewportWidth: 600,
      viewportHeight: 600,
      imageWidth: 300,
      imageHeight: 600,
    };

    expect(getContainedPanBounds({ ...input, scale: 1 })).toEqual({ x: 0, y: 0 });
    expect(getContainedPanBounds({ ...input, scale: 2 })).toEqual({ x: 0, y: 300 });
    expect(getContainedPanBounds({ ...input, scale: 3 })).toEqual({ x: 150, y: 600 });
  });

  it("uses the rendered landscape image instead of viewport letterbox space", () => {
    const input = {
      viewportWidth: 600,
      viewportHeight: 600,
      imageWidth: 600,
      imageHeight: 300,
    };

    expect(getContainedPanBounds({ ...input, scale: 1 })).toEqual({ x: 0, y: 0 });
    expect(getContainedPanBounds({ ...input, scale: 2 })).toEqual({ x: 300, y: 0 });
    expect(getContainedPanBounds({ ...input, scale: 3 })).toEqual({ x: 600, y: 150 });
  });

  it("does not allow panning before the viewport and image are measured", () => {
    expect(
      getContainedPanBounds({
        viewportWidth: 600,
        viewportHeight: 600,
        imageWidth: 0,
        imageHeight: 0,
        scale: 4,
      }),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("getFocalTranslation", () => {
  it("keeps the image point under a stationary off-center focal point", () => {
    const startScale = 1;
    const nextScale = 2;
    const startFocal = 100;
    const startTranslation = 0;
    const nextTranslation = getFocalTranslation({
      startTranslation,
      startFocal,
      focal: startFocal,
      scaleRatio: nextScale / startScale,
    });

    expect(nextTranslation).toBe(-100);
    expect((startFocal - startTranslation) / startScale).toBe(
      (startFocal - nextTranslation) / nextScale,
    );
  });

  it("keeps the same image point under a moving focal point", () => {
    const startScale = 2;
    const nextScale = 4;
    const startFocal = 100;
    const focal = 120;
    const startTranslation = 40;
    const nextTranslation = getFocalTranslation({
      startTranslation,
      startFocal,
      focal,
      scaleRatio: nextScale / startScale,
    });

    expect(nextTranslation).toBe(0);
    expect((startFocal - startTranslation) / startScale).toBe(
      (focal - nextTranslation) / nextScale,
    );
  });
});

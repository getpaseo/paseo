import { describe, expect, it } from "vitest";
import { fitAssistantImagePreview } from "./preview-layout";

describe("assistant image preview layout", () => {
  it("does not upscale images smaller than the available space", () => {
    expect(
      fitAssistantImagePreview({
        intrinsicWidth: 120,
        intrinsicHeight: 80,
        containerWidth: 800,
        viewportHeight: 900,
      }),
    ).toEqual({ width: 120, height: 80 });
  });

  it("fits a landscape image to both the container and viewport budget", () => {
    expect(
      fitAssistantImagePreview({
        intrinsicWidth: 1600,
        intrinsicHeight: 900,
        containerWidth: 820,
        viewportHeight: 800,
      }),
    ).toEqual({ width: 640, height: 360 });
  });

  it("keeps a portrait image compact without cropping it", () => {
    expect(
      fitAssistantImagePreview({
        intrinsicWidth: 1080,
        intrinsicHeight: 2400,
        containerWidth: 820,
        viewportHeight: 800,
      }),
    ).toEqual({ width: 162, height: 360 });
  });

  it("uses the available width when only the aspect ratio is known", () => {
    expect(
      fitAssistantImagePreview({
        aspectRatio: 2,
        containerWidth: 360,
        viewportHeight: 800,
      }),
    ).toEqual({ width: 360, height: 180 });
  });

  it("keeps a stable fallback when layout inputs are not usable", () => {
    expect(
      fitAssistantImagePreview({
        intrinsicWidth: 0,
        intrinsicHeight: 0,
        aspectRatio: Number.NaN,
        containerWidth: 0,
        viewportHeight: 0,
      }),
    ).toEqual({ width: 0, height: 160 });
  });
});

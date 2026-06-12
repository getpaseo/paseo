import { describe, expect, it } from "vitest";
import {
  getMimeTypeFromPath,
  getRasterImageMimeTypeFromPath,
  isRasterImageFile,
  isRasterImageMimeType,
  isRasterImagePath,
  RASTER_IMAGE_FILE_EXTENSIONS,
} from "./file-types";

describe("attachment file types", () => {
  it("keeps SVG as a file while treating raster image files as images", () => {
    expect(getMimeTypeFromPath("/tmp/logo.svg")).toBe("image/svg+xml");
    expect(isRasterImagePath("/tmp/logo.svg")).toBe(false);
    expect(isRasterImageMimeType("image/svg+xml")).toBe(false);
    expect(isRasterImageFile(new File(["<svg />"], "logo.svg", { type: "image/svg+xml" }))).toBe(
      false,
    );

    expect(getRasterImageMimeTypeFromPath("/tmp/screenshot.PNG?cache=1")).toBe("image/png");
    expect(isRasterImagePath("/tmp/screenshot.PNG?cache=1")).toBe(true);
    expect(isRasterImageMimeType("image/png; charset=binary")).toBe(true);
    expect(isRasterImageFile(new File([new Uint8Array([0])], "screenshot.png"))).toBe(true);
  });

  it("does not offer SVG in the image picker extension list", () => {
    expect(new Set(RASTER_IMAGE_FILE_EXTENSIONS)).toEqual(
      new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"]),
    );
  });
});

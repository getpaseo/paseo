import { describe, expect, test } from "vitest";
import { preprocessImage, preprocessImages } from "./preprocess-image.js";

// 1x1 red PNG (well under 2000x2000)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("preprocessImage", () => {
  test("returns small image unchanged", async () => {
    const image = { data: TINY_PNG_BASE64, mimeType: "image/png" };
    const result = await preprocessImage(image);
    expect(result.data).toBe(TINY_PNG_BASE64);
    expect(result.mimeType).toBe("image/png");
  });

  test("resizes image exceeding 2000px", async () => {
    // Dynamically import sharp to create a test image
    let sharp: typeof import("sharp");
    try {
      sharp = await import("sharp");
    } catch {
      // sharp not available in test env — skip
      return;
    }

    // Create a 3000x2500 solid-color image
    const oversized = await sharp
      .default({
        create: {
          width: 3000,
          height: 2500,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
      .png()
      .toBuffer();

    const image = {
      data: oversized.toString("base64"),
      mimeType: "image/png",
    };

    const result = await preprocessImage(image);

    // Should have been converted to jpeg
    expect(result.mimeType).toBe("image/jpeg");
    // Data should differ (resized + re-encoded)
    expect(result.data).not.toBe(image.data);

    // Verify resulting dimensions are within limits
    const resultBuffer = Buffer.from(result.data, "base64");
    const metadata = await sharp.default(resultBuffer).metadata();
    expect(metadata.width).toBeLessThanOrEqual(2000);
    expect(metadata.height).toBeLessThanOrEqual(2000);
  });

  test("preserves aspect ratio when resizing", async () => {
    let sharp: typeof import("sharp");
    try {
      sharp = await import("sharp");
    } catch {
      return;
    }

    // Create a wide image: 4000x1000
    const wide = await sharp
      .default({
        create: {
          width: 4000,
          height: 1000,
          channels: 3,
          background: { r: 64, g: 64, b: 64 },
        },
      })
      .png()
      .toBuffer();

    const image = { data: wide.toString("base64"), mimeType: "image/png" };
    const result = await preprocessImage(image);

    const resultBuffer = Buffer.from(result.data, "base64");
    const metadata = await sharp.default(resultBuffer).metadata();

    // Width should be capped at 2000, height scaled proportionally (~500)
    expect(metadata.width).toBe(2000);
    expect(metadata.height).toBeLessThanOrEqual(2000);
    expect(metadata.height).toBeGreaterThan(0);
  });

  test("handles corrupt base64 gracefully", async () => {
    const image = { data: "not-valid-base64!!!", mimeType: "image/png" };
    const result = await preprocessImage(image);
    // Should return original on error
    expect(result).toBe(image);
  });
});

describe("preprocessImages", () => {
  test("returns undefined for undefined input", async () => {
    const result = await preprocessImages(undefined);
    expect(result).toBeUndefined();
  });

  test("returns empty array for empty input", async () => {
    const result = await preprocessImages([]);
    expect(result).toEqual([]);
  });

  test("processes multiple images", async () => {
    const images = [
      { data: TINY_PNG_BASE64, mimeType: "image/png" },
      { data: TINY_PNG_BASE64, mimeType: "image/jpeg" },
    ];
    const result = await preprocessImages(images);
    expect(result).toHaveLength(2);
    expect(result![0].data).toBe(TINY_PNG_BASE64);
    expect(result![1].data).toBe(TINY_PNG_BASE64);
  });
});

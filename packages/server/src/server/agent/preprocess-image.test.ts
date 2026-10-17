import { describe, expect, test } from "vitest";
import photon from "@silvia-odwyer/photon-node";
import {
  preprocessImage,
  preprocessImages,
  ImageDecodeError,
  ImageTooLargeError,
  TooManyImagesError,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PROMPT,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
} from "./preprocess-image.js";

// The decoder is a declared dependency, so a failed import is a hard failure
// rather than a reason to skip: a suite that swallows a missing codec reports
// the guard as working when it is forwarding everything untouched.

type Fill = "flat" | "noise" | "transparent";

function pixels(width: number, height: number, fill: Fill): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (fill === "noise") {
        // Flat colour compresses to almost nothing, which makes byte-budget
        // assertions meaningless. Noise keeps the encoded size honest.
        const v = ((x * 2654435761) ^ (y * 40503)) >>> 0;
        data[i] = v & 0xff;
        data[i + 1] = (v >>> 8) & 0xff;
        data[i + 2] = (v >>> 16) & 0xff;
        data[i + 3] = 0xff;
      } else {
        data[i] = 0x80;
        data[i + 1] = 0x80;
        data[i + 2] = 0x80;
        // Left half transparent, right half opaque.
        data[i + 3] = fill === "transparent" && x < width / 2 ? 0 : 0xff;
      }
    }
  }
  return data;
}

function makePng(width: number, height: number, fill: Fill = "flat"): string {
  const image = new photon.PhotonImage(pixels(width, height, fill), width, height);
  try {
    return Buffer.from(image.get_bytes()).toString("base64");
  } finally {
    image.free();
  }
}

function makeJpeg(width: number, height: number, fill: Fill = "flat"): Uint8Array {
  const image = new photon.PhotonImage(pixels(width, height, fill), width, height);
  try {
    return image.get_bytes_jpeg(80);
  } finally {
    image.free();
  }
}

/**
 * A PNG header and nothing else. What a client claims its image is, without
 * the pixels to back it up — which is the shape a decompression bomb arrives in.
 */
function makePngHeader(width: number, height: number, bodyBytes = 0): string {
  const header = Buffer.alloc(24 + bodyBytes, 0xa5);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

/** A GIF89a logical screen descriptor, with no frames behind it. */
function makeGifHeader(width: number, height: number, bodyBytes = 0): string {
  const header = Buffer.alloc(13 + bodyBytes, 0xa5);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header.toString("base64");
}

/** Splice an APP1 EXIF segment carrying `orientation` in after the SOI marker. */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM", 0, "ascii"); // big-endian
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // next IFD
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const segment = Buffer.alloc(4 + payload.length);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), segment, Buffer.from(jpeg.subarray(2))]);
}

function decode(base64: string): {
  width: number;
  height: number;
  alphaAt: (x: number, y: number) => number;
} {
  const image = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"));
  try {
    const width = image.get_width();
    const raw = image.get_raw_pixels();
    return {
      width,
      height: image.get_height(),
      alphaAt: (x, y) => raw[(y * width + x) * 4 + 3]!,
    };
  } finally {
    image.free();
  }
}

describe("preprocessImage", () => {
  test("leaves an image that is already within both ceilings byte-identical", async () => {
    const image = { data: makePng(800, 600), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
  });

  test("clamps the reported 4864x2524 screenshot under the pixel ceiling, as PNG", async () => {
    const image = { data: makePng(4864, 2524), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    const { width, height } = decode(result.data);
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    // A UI screenshot that only needed a downscale keeps its text sharp.
    expect(result.mimeType).toBe("image/png");
  });

  test("preserves aspect ratio when clamping", async () => {
    const image = { data: makePng(4000, 1000), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    const { width, height } = decode(result.data);
    expect(width).toBe(MAX_IMAGE_DIMENSION);
    expect(height).toBe(MAX_IMAGE_DIMENSION / 4);
  });

  test("keeps transparency through a downscale", async () => {
    const image = { data: makePng(3000, 3000, "transparent"), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    const { width, alphaAt } = decode(result.data);
    expect(result.mimeType).toBe("image/png");
    expect(alphaAt(10, 10)).toBe(0);
    expect(alphaAt(width - 10, 10)).toBe(0xff);
  });

  test("brings an over-budget payload under the byte ceiling", async () => {
    const data = makePng(1200, 1200, "noise");
    const maxBytes = Math.floor(data.length / 4);

    const result = await preprocessImage({
      image: { data, mimeType: "image/png" },
      limits: { maxBytes },
    });

    expect(result.data.length).toBeLessThanOrEqual(maxBytes);
  });

  test("falls through to JPEG only when PNG cannot make budget", async () => {
    // Noise defeats PNG, so a byte-limited noise image is the case that
    // legitimately ends up as JPEG.
    const data = makePng(1200, 1200, "noise");
    const maxBytes = Math.floor(data.length / 4);

    const result = await preprocessImage({
      image: { data, mimeType: "image/png" },
      limits: { maxBytes },
    });

    expect(result.mimeType).toBe("image/jpeg");
  });

  test("never transcodes a PNG that is inside both ceilings", async () => {
    const image = { data: makePng(1000, 1000), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
    expect(result.mimeType).toBe("image/png");
  });

  test("shrinks past the quality floor when quality alone cannot make budget", async () => {
    const data = makePng(1200, 1200, "noise");
    const maxBytes = Math.floor(data.length / 40);

    const result = await preprocessImage({
      image: { data, mimeType: "image/png" },
      limits: { maxBytes },
    });

    const { width } = decode(result.data);
    expect(result.data.length).toBeLessThanOrEqual(maxBytes);
    expect(width).toBeLessThan(1200);
  });

  test("clamps pixels even when the re-encode grows the payload", async () => {
    // The pixel ceiling is the bug being fixed, so it outranks byte thriftiness.
    const image = { data: makePng(2400, 2400), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    const { width } = decode(result.data);
    expect(width).toBe(MAX_IMAGE_DIMENSION);
  });

  test("honours EXIF orientation so a downscaled phone photo is not sideways", async () => {
    // Orientation 6: stored landscape, meant to be shown rotated 90° clockwise.
    const jpeg = withExifOrientation(makeJpeg(3000, 1500), 6);
    const image = { data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" };

    const result = await preprocessImage({ image });

    const { width, height } = decode(result.data);
    expect(width).toBe(1000);
    expect(height).toBe(MAX_IMAGE_DIMENSION);
  });

  test("passes an in-limit GIF through so animation is not flattened to one frame", async () => {
    const image = { data: makeGifHeader(800, 600), mimeType: "image/gif" };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
  });

  test("passes SVG through because it has no raster dimensions to clamp", async () => {
    const image = {
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9000"/>').toString(
        "base64",
      ),
      mimeType: "image/svg+xml",
    };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
  });

  test("honours a mime type that carries parameters", async () => {
    const image = { data: makeGifHeader(800, 600), mimeType: "image/gif; charset=binary" };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
  });

  test("forwards an in-budget attachment it cannot read rather than dropping it", async () => {
    // Nothing here says the image is oversized, and a format this daemon cannot
    // parse may still be one the provider accepts.
    const image = { data: "not-valid-base64!!!", mimeType: "image/png" };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
  });
});

describe("resource ceilings", () => {
  test("refuses a decompression bomb from its header, without decoding it", async () => {
    // 3.6 gigapixels declared in 24 bytes. Decoding first to measure it is the
    // allocation this ceiling exists to refuse.
    const image = { data: makePngHeader(60_000, 60_000), mimeType: "image/png" };

    await expect(preprocessImage({ image })).rejects.toThrow(ImageTooLargeError);
  });

  test("names the declared size when refusing a bomb", async () => {
    const image = { data: makePngHeader(60_000, 60_000), mimeType: "image/png" };

    const error = await preprocessImage({ image }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImageTooLargeError);
    expect(error).toMatchObject({ width: 60_000, height: 60_000, mimeType: "image/png" });
  });

  test("accepts a large image that stays under the decode ceiling", async () => {
    const image = { data: makePng(3000, 2000), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    expect(decode(result.data).width).toBe(MAX_IMAGE_DIMENSION);
  });

  test("refuses a payload past the encoded byte ceiling before decoding it", async () => {
    const image = { data: "A".repeat(MAX_SOURCE_BYTES + 1), mimeType: "image/png" };

    await expect(preprocessImage({ image })).rejects.toThrow(ImageTooLargeError);
  });

  test("refuses an over-budget attachment whose container it cannot read", async () => {
    // Forwarding it is what poisons the conversation: it is over the provider's
    // budget and there is no readable header to resize from.
    const image = { data: "A".repeat(MAX_IMAGE_BYTES + 1), mimeType: "image/tiff" };

    await expect(preprocessImage({ image })).rejects.toThrow(ImageTooLargeError);
  });

  test("refuses an oversized GIF instead of forwarding what it cannot resize", async () => {
    // Re-encoding is off the table, but the provider limit is not: forwarding a
    // 4000px GIF is the same poisoned conversation the clamp exists to prevent.
    const image = { data: makeGifHeader(4000, 2000), mimeType: "image/gif" };

    const error = await preprocessImage({ image }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImageTooLargeError);
    expect(error).toMatchObject({ width: 4000, height: 2000, mimeType: "image/gif" });
  });

  test("refuses a passthrough attachment over the provider's byte budget", async () => {
    const image = { data: makeGifHeader(100, 100, 4096), mimeType: "image/gif" };

    await expect(preprocessImage({ image, limits: { maxBytes: 512 } })).rejects.toThrow(
      ImageTooLargeError,
    );
  });

  test("applies the encoded byte ceiling to a passthrough format too", async () => {
    const image = { data: "A".repeat(MAX_SOURCE_BYTES + 1), mimeType: "image/svg+xml" };

    await expect(preprocessImage({ image })).rejects.toThrow(ImageTooLargeError);
  });

  test("does not decode an attachment that is already within both ceilings", async () => {
    // A valid header over a body no decoder could read: reaching the decoder at
    // all would throw, so passing proves the fast path never got there.
    const image = { data: makePngHeader(800, 600, 512), mimeType: "image/png" };

    const result = await preprocessImage({ image });

    expect(result).toBe(image);
  });

  test("reports a codec failure on an oversized attachment instead of forwarding it", async () => {
    const image = { data: makePngHeader(4864, 2524, 512), mimeType: "image/png" };

    await expect(preprocessImage({ image })).rejects.toThrow(ImageDecodeError);
  });

  test("still clamps normally after a codec failure", async () => {
    // A trap inside the WASM decoder must not leave the module unusable for
    // every later attachment.
    await preprocessImage({
      image: { data: makePngHeader(4864, 2524, 512), mimeType: "image/png" },
    }).catch(() => undefined);

    const result = await preprocessImage({
      image: { data: makePng(3000, 1200), mimeType: "image/png" },
    });

    expect(decode(result.data).width).toBe(MAX_IMAGE_DIMENSION);
  });

  test("exposes a byte ceiling below the 5MB provider limit", () => {
    expect(MAX_IMAGE_BYTES).toBeLessThan(5 * 1024 * 1024);
  });

  test("exposes a decode ceiling that still clears a 48MP phone photo", () => {
    expect(MAX_SOURCE_PIXELS).toBeGreaterThan(48_000_000);
  });
});

describe("preprocessImages", () => {
  test("returns undefined for undefined input", async () => {
    expect(await preprocessImages({ images: undefined })).toBeUndefined();
  });

  test("returns an empty array unchanged", async () => {
    expect(await preprocessImages({ images: [] })).toEqual([]);
  });

  test("clamps every oversized attachment in one prompt", async () => {
    const images = [
      { data: makePng(3000, 3000), mimeType: "image/png" },
      { data: makePng(800, 600), mimeType: "image/png" },
      { data: makePng(2500, 1000), mimeType: "image/png" },
    ];

    const result = await preprocessImages({ images });

    expect(result).toHaveLength(3);
    for (const entry of result!) {
      const { width, height } = decode(entry.data);
      expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    }
    expect(result![1]).toBe(images[1]);
  });

  test("refuses a prompt carrying more images than any provider accepts", async () => {
    const images = Array.from({ length: MAX_IMAGES_PER_PROMPT + 1 }, () => ({
      data: makePng(8, 8),
      mimeType: "image/png",
    }));

    await expect(preprocessImages({ images })).rejects.toThrow(TooManyImagesError);
  });

  test("accepts a prompt at the image limit", async () => {
    const images = Array.from({ length: MAX_IMAGES_PER_PROMPT }, () => ({
      data: makePng(8, 8),
      mimeType: "image/png",
    }));

    expect(await preprocessImages({ images })).toHaveLength(MAX_IMAGES_PER_PROMPT);
  });
});

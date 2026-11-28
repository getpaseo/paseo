import { describe, expect, it } from "vitest";
import {
  MAX_PICKED_IMAGE_EDGE,
  normalizePickedImageAssetsWith,
  type RenderPickedImage,
  type RenderPickedImageOptions,
} from "./picked-image-normalizer";

function fakeRenderer(): {
  render: RenderPickedImage;
  calls: { uri: string; options: RenderPickedImageOptions }[];
} {
  const calls: { uri: string; options: RenderPickedImageOptions }[] = [];
  return {
    render: async (uri, options) => {
      calls.push({ uri, options });
      return `file:///cache/ImageManipulator/rendered.${options.format === "jpeg" ? "jpg" : "png"}`;
    },
    calls,
  };
}

describe("native image attachment picker", () => {
  it("preserves native picked JPEG and PNG attachment inputs", async () => {
    const { render, calls } = fakeRenderer();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0001.JPG",
          mimeType: "image/jpeg",
          fileName: "picked.jpeg",
          width: 1600,
          height: 1200,
        },
        {
          uri: "file:///photos/screenshot.png",
          mimeType: "image/png",
          fileName: "screenshot.png",
        },
      ],
      render,
    );

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/IMG_0001.JPG" },
        mimeType: "image/jpeg",
        fileName: "picked.jpg",
      },
      {
        source: { kind: "file_uri", uri: "file:///photos/screenshot.png" },
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("uses explicit native MIME metadata before the URI extension", async () => {
    const { render, calls } = fakeRenderer();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/screenshot.jpg",
          mimeType: "image/png",
          fileName: "screenshot.png",
        },
      ],
      render,
    );

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/screenshot.jpg" },
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("turns a full-resolution HEIC photo into a downscaled JPEG", async () => {
    const { render, calls } = fakeRenderer();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0001.HEIC",
          mimeType: "image/png",
          fileName: "picked.png",
          width: 4032,
          height: 3024,
        },
      ],
      render,
    );

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImageManipulator/rendered.jpg" },
        mimeType: "image/jpeg",
        fileName: "picked.jpg",
      },
    ]);
    expect(calls).toEqual([
      {
        uri: "file:///photos/IMG_0001.HEIC",
        options: { format: "jpeg", compress: 0.85, resize: { width: MAX_PICKED_IMAGE_EDGE } },
      },
    ]);
  });

  it("converts a HEIC photo of unknown size to JPEG without resizing", async () => {
    const { render, calls } = fakeRenderer();

    await normalizePickedImageAssetsWith(
      [{ uri: "file:///photos/IMG_0002.heic", mimeType: "image/heic", width: 0, height: 0 }],
      render,
    );

    expect(calls).toEqual([
      {
        uri: "file:///photos/IMG_0002.heic",
        options: { format: "jpeg", compress: 0.85, resize: null },
      },
    ]);
  });

  it("downscales an oversized portrait JPEG and keeps it JPEG", async () => {
    const { render, calls } = fakeRenderer();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///camera/photo.jpg",
          mimeType: "image/jpeg",
          fileName: "photo.jpg",
          width: 3024,
          height: 4032,
        },
      ],
      render,
    );

    expect(result[0]?.mimeType).toBe("image/jpeg");
    expect(calls).toEqual([
      {
        uri: "file:///camera/photo.jpg",
        options: { format: "jpeg", compress: 0.85, resize: { height: MAX_PICKED_IMAGE_EDGE } },
      },
    ]);
  });

  it("downscales an oversized screenshot and keeps it lossless PNG", async () => {
    const { render, calls } = fakeRenderer();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/screenshot.png",
          mimeType: "image/png",
          width: 1290,
          height: 2796,
        },
      ],
      render,
    );

    expect(result[0]?.mimeType).toBe("image/png");
    expect(calls[0]?.options).toEqual({
      format: "png",
      compress: 0.85,
      resize: { height: MAX_PICKED_IMAGE_EDGE },
    });
  });

  it("converts other unsupported formats to PNG so transparency survives", async () => {
    const { render, calls } = fakeRenderer();

    const result = await normalizePickedImageAssetsWith(
      [{ uri: "file:///photos/sticker.webp", mimeType: "image/webp", width: 512, height: 512 }],
      render,
    );

    expect(result[0]?.mimeType).toBe("image/png");
    expect(calls[0]?.options).toEqual({ format: "png", compress: 0.85, resize: null });
  });
});

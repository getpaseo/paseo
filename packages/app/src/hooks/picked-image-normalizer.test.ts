import { describe, expect, it } from "vitest";
import {
  normalizePickedImageAssetsWith,
  type ExportPickedImageAsPng,
} from "./picked-image-normalizer";

function fakeExportAsPng(): {
  exportAsPng: ExportPickedImageAsPng;
  recordedUris: string[];
} {
  const recordedUris: string[] = [];
  return {
    exportAsPng: async (uri: string) => {
      recordedUris.push(uri);
      return "file:///cache/ImageManipulator/safe-picked.png";
    },
    recordedUris,
  };
}

describe("native image attachment picker", () => {
  it("preserves native picked JPEG and PNG attachment inputs", async () => {
    const { exportAsPng, recordedUris } = fakeExportAsPng();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0001.JPG",
          mimeType: "image/jpeg",
          fileName: "picked.jpeg",
        },
        {
          uri: "file:///photos/screenshot.png",
          mimeType: "image/png",
          fileName: "screenshot.png",
        },
      ],
      exportAsPng,
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
    expect(recordedUris).toEqual([]);
  });

  it("turns a native picked HEIC-like asset into a PNG attachment input", async () => {
    const { exportAsPng, recordedUris } = fakeExportAsPng();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0001.HEIC",
          mimeType: "image/png",
          fileName: "picked.png",
        },
      ],
      exportAsPng,
    );

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImageManipulator/safe-picked.png" },
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);
    expect(recordedUris).toEqual(["file:///photos/IMG_0001.HEIC"]);
  });
});

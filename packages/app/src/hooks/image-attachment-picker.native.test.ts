import { describe, expect, it, vi } from "vitest";

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { PNG: "png" },
  ImageManipulator: {
    manipulate: (_source: string) => ({
      async renderAsync() {
        return {
          release() {},
          async saveAsync(options: { format?: string }) {
            return {
              uri:
                options.format === "png"
                  ? "file:///cache/ImageManipulator/safe-picked.png"
                  : "file:///cache/ImageManipulator/unsafe-picked.jpg",
              width: 100,
              height: 100,
            };
          },
        };
      },
      release() {},
    }),
  },
}));

import { normalizePickedImageAssets } from "./image-attachment-picker.native";

describe("native image attachment picker", () => {
  it("preserves native picked JPEG and PNG attachment inputs", async () => {
    const result = await normalizePickedImageAssets([
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
    ]);

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
  });

  it("turns a native picked HEIC-like asset into a PNG attachment input", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///photos/IMG_0001.HEIC",
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImageManipulator/safe-picked.png" },
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);
  });
});

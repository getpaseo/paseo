import { describe, expect, it, vi } from "vitest";

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: (_source: string) => ({
      async renderAsync() {
        return {
          release() {},
          async saveAsync(options: { format?: string }) {
            return {
              uri:
                options.format === "jpeg"
                  ? "file:///cache/ImageManipulator/safe-picked.jpg"
                  : "file:///cache/ImageManipulator/unsafe-picked.png",
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
  it("turns a native picked HEIC-like asset into a JPEG attachment input", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///photos/IMG_0001.HEIC",
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImageManipulator/safe-picked.jpg" },
        mimeType: "image/jpeg",
        fileName: "picked.jpg",
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { PickedImageAttachmentInput } from "./picked-image-normalizer";
import { normalizePickedMediaAssetsWith } from "./picked-media-normalizer";

describe("native media attachment picker", () => {
  it("keeps images in the image attachment pipeline", async () => {
    const image: PickedImageAttachmentInput = {
      source: { kind: "file_uri", uri: "file:///photos/picked.jpg" },
      mimeType: "image/jpeg",
      fileName: "picked.jpg",
    };

    const result = await normalizePickedMediaAssetsWith({
      assets: [
        {
          uri: "file:///photos/picked.jpg",
          mimeType: "image/jpeg",
          fileName: "picked.jpg",
          type: "image",
        },
      ],
      normalizeImage: async () => image,
      readVideoBytes: async () => new Uint8Array(),
    });

    expect(result).toEqual([{ kind: "image", attachment: image }]);
  });

  it("turns videos into picked files without passing them to image conversion", async () => {
    const recordedImageAssets: string[] = [];
    const recordedVideoUris: string[] = [];
    const videoBytes = new Uint8Array([1, 2, 3]);

    const result = await normalizePickedMediaAssetsWith({
      assets: [
        {
          uri: "file:///photos/demo.mov",
          mimeType: "video/quicktime",
          fileName: "demo.mov",
          type: "video",
        },
      ],
      normalizeImage: async (asset) => {
        recordedImageAssets.push(asset.uri);
        throw new Error("Video was sent to image normalization.");
      },
      readVideoBytes: async (uri) => {
        recordedVideoUris.push(uri);
        return videoBytes;
      },
    });

    expect(result).toEqual([
      {
        kind: "file",
        file: {
          fileName: "demo.mov",
          mimeType: "video/quicktime",
          bytes: videoBytes,
        },
      },
    ]);
    expect(recordedImageAssets).toEqual([]);
    expect(recordedVideoUris).toEqual(["file:///photos/demo.mov"]);
  });

  it("recognizes a video from MIME metadata when the picker omits its asset type", async () => {
    const result = await normalizePickedMediaAssetsWith({
      assets: [
        {
          uri: "file:///photos/clip.mp4",
          mimeType: "video/mp4",
          fileName: null,
          type: null,
        },
      ],
      normalizeImage: async () => {
        throw new Error("Video was sent to image normalization.");
      },
      readVideoBytes: async () => new Uint8Array([4, 5]),
    });

    expect(result).toEqual([
      {
        kind: "file",
        file: {
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          bytes: new Uint8Array([4, 5]),
        },
      },
    ]);
  });
});

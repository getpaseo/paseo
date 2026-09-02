import { describe, expect, it } from "vitest";
import {
  savePreviewImage,
  sharePreviewImage,
  type ImagePreviewActionPort,
} from "./image-preview-actions";

function createPort(permissionGranted = true): {
  port: ImagePreviewActionPort;
  savedUris: string[];
  sharedImages: Array<{ uri: string; mimeType: string; fileName: string }>;
} {
  const savedUris: string[] = [];
  const sharedImages: Array<{ uri: string; mimeType: string; fileName: string }> = [];
  return {
    savedUris,
    sharedImages,
    port: {
      requestSavePermission: async () => permissionGranted,
      saveToPhotoLibrary: async (uri) => {
        savedUris.push(uri);
      },
      share: async (input) => {
        sharedImages.push(input);
      },
    },
  };
}

describe("image preview actions", () => {
  it("saves the cached preview after write permission is granted", async () => {
    const { port, savedUris } = createPort();

    await expect(savePreviewImage("file:///cache/original.png", port)).resolves.toBe("saved");
    expect(savedUris).toEqual(["file:///cache/original.png"]);
  });

  it("does not save when write permission is denied", async () => {
    const { port, savedUris } = createPort(false);

    await expect(savePreviewImage("file:///cache/original.png", port)).resolves.toBe(
      "permission-denied",
    );
    expect(savedUris).toEqual([]);
  });

  it("allows saving to be retried after a write failure", async () => {
    const { port, savedUris } = createPort();
    const saveToPhotoLibrary = port.saveToPhotoLibrary;
    let shouldFail = true;
    port.saveToPhotoLibrary = async (uri) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("write failed");
      }
      await saveToPhotoLibrary(uri);
    };

    await expect(savePreviewImage("file:///cache/original.png", port)).rejects.toThrow(
      "write failed",
    );
    await expect(savePreviewImage("file:///cache/original.png", port)).resolves.toBe("saved");
    expect(savedUris).toEqual(["file:///cache/original.png"]);
  });

  it("shares the cached preview with its original metadata", async () => {
    const { port, sharedImages } = createPort();
    const image = {
      uri: "file:///cache/original.png",
      mimeType: "image/png",
      fileName: "original.png",
    };

    await sharePreviewImage(image, port);
    expect(sharedImages).toEqual([image]);
  });
});

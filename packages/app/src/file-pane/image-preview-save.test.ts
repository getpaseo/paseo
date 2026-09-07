import { describe, expect, it } from "vitest";
import { savePreviewImage, type ImagePreviewLibrary } from "./image-preview-save";

function createLibrary(permissionGranted = true): {
  library: ImagePreviewLibrary;
  savedUris: string[];
} {
  const savedUris: string[] = [];
  return {
    savedUris,
    library: {
      requestSavePermission: async () => permissionGranted,
      saveToPhotoLibrary: async (uri) => {
        savedUris.push(uri);
      },
    },
  };
}

describe("savePreviewImage", () => {
  it("saves the preview after write permission is granted", async () => {
    const { library, savedUris } = createLibrary();

    await expect(savePreviewImage("file:///cache/image.png", library)).resolves.toBe("saved");
    expect(savedUris).toEqual(["file:///cache/image.png"]);
  });

  it("does not save when write permission is denied", async () => {
    const { library, savedUris } = createLibrary(false);

    await expect(savePreviewImage("file:///cache/image.png", library)).resolves.toBe(
      "permission-denied",
    );
    expect(savedUris).toEqual([]);
  });

  it("allows retrying after a write failure", async () => {
    const { library, savedUris } = createLibrary();
    const saveToPhotoLibrary = library.saveToPhotoLibrary;
    let shouldFail = true;
    library.saveToPhotoLibrary = async (uri) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("write failed");
      }
      await saveToPhotoLibrary(uri);
    };

    await expect(savePreviewImage("file:///cache/image.png", library)).rejects.toThrow(
      "write failed",
    );
    await expect(savePreviewImage("file:///cache/image.png", library)).resolves.toBe("saved");
    expect(savedUris).toEqual(["file:///cache/image.png"]);
  });
});

import { describe, expect, it } from "vitest";
import { readClipboardImage, type ClipboardImageReader } from "./clipboard-image";

function createClipboard(input: {
  hasImage: boolean;
  imageData?: string | null;
}): ClipboardImageReader {
  return {
    hasImageAsync: async () => input.hasImage,
    getImageAsync: async () =>
      input.imageData === undefined || input.imageData === null ? null : { data: input.imageData },
  };
}

describe("readClipboardImage", () => {
  it("returns null when the clipboard does not contain an image", async () => {
    await expect(readClipboardImage(createClipboard({ hasImage: false }))).resolves.toBeNull();
  });

  it("returns the clipboard image as a persistable data URL", async () => {
    const dataUrl = "data:image/png;base64,AAEC";

    await expect(
      readClipboardImage(createClipboard({ hasImage: true, imageData: dataUrl })),
    ).resolves.toEqual({
      source: { kind: "data_url", dataUrl },
      mimeType: "image/png",
      fileName: "clipboard.png",
    });
  });

  it("returns null when the clipboard image disappears before it is read", async () => {
    await expect(
      readClipboardImage(createClipboard({ hasImage: true, imageData: null })),
    ).resolves.toBeNull();
  });
});

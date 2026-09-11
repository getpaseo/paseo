import { describe, expect, it } from "vitest";
import { createLocalFileAttachmentStore } from "./local-file-attachment-store";
import { createTestAttachmentFileSystem } from "./test-attachment-file-system";

describe("local file attachment store", () => {
  it("decodes data URL sources before writing the managed file", async () => {
    const fileSystem = createTestAttachmentFileSystem();
    const store = createLocalFileAttachmentStore({
      storageType: "native-file",
      baseDirectoryName: "paseo-native-attachments",
      fileSystem,
      resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
    });

    const attachment = await store.save({
      id: "clipboard_image",
      mimeType: "image/png",
      fileName: "clipboard.png",
      source: { kind: "data_url", dataUrl: "data:image/png;base64,AAECAw==" },
    });

    expect(attachment).toMatchObject({
      id: "clipboard_image",
      mimeType: "image/png",
      storageType: "native-file",
      storageKey: "/cache/paseo-native-attachments/clipboard_image.png",
      fileName: "clipboard.png",
      byteSize: 4,
    });
    expect(
      fileSystem.files.get("file:///cache/paseo-native-attachments/clipboard_image.png"),
    ).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it("writes raw byte sources directly to the managed file path", async () => {
    const fileSystem = createTestAttachmentFileSystem();
    const store = createLocalFileAttachmentStore({
      storageType: "native-file",
      baseDirectoryName: "preview-assets",
      fileSystem,
      resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
    });

    const attachment = await store.save({
      id: "preview_8_test",
      mimeType: "image/png",
      fileName: "result.png",
      source: { kind: "bytes", bytes: new Uint8Array([0, 1, 2, 3]) },
    });

    expect(attachment).toMatchObject({
      id: "preview_8_test",
      mimeType: "image/png",
      storageType: "native-file",
      storageKey: "/cache/preview-assets/preview_8_test.png",
      fileName: "result.png",
      byteSize: 4,
    });
    expect(fileSystem.files.get("file:///cache/preview-assets/preview_8_test.png")).toEqual(
      new Uint8Array([0, 1, 2, 3]),
    );
    expect(fileSystem.directories.has("file:///cache/preview-assets")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { createLocalFileAttachmentStore } from "./local-file-attachment-store";
import { createTestAttachmentFileSystem } from "./test-attachment-file-system";

function createStore() {
  const fileSystem = createTestAttachmentFileSystem();
  const store = createLocalFileAttachmentStore({
    storageType: "native-file",
    baseDirectoryName: "preview-assets",
    fileSystem,
    resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
  });
  return { fileSystem, store };
}

describe("local file attachment store", () => {
  it.each([
    "data:image/png;base64,AAECAwQF+/8=",
    "data:image/png;charset=utf-8;base64,AAEC\nAwQF+/8=",
  ])("preserves binary image bytes from %s", async (dataUrl) => {
    const { fileSystem, store } = createStore();
    const attachment = await store.save({
      id: "clipboard",
      fileName: "clipboard.png",
      source: { kind: "data_url", dataUrl },
    });

    expect(attachment).toMatchObject({
      mimeType: "image/png",
      fileName: "clipboard.png",
      byteSize: 8,
      storageType: "native-file",
      storageKey: "/cache/preview-assets/clipboard.png",
    });
    expect(fileSystem.files.get("file:///cache/preview-assets/clipboard.png")).toEqual(
      new Uint8Array([0, 1, 2, 3, 4, 5, 251, 255]),
    );
    await expect(store.encodeBase64({ attachment })).resolves.toBe("AAECAwQF+/8=");
    await expect(store.resolvePreviewUrl({ attachment })).resolves.toBe(
      "file:///cache/preview-assets/clipboard.png",
    );
  });

  it.each([
    "not-a-data-url",
    "data:image/png,hello",
    "data:image/png;base64,",
    "data:image/png;base64,%%%%",
    "data:image/png;base64,A",
  ])("rejects malformed image data without writing a file: %s", async (dataUrl) => {
    const { fileSystem, store } = createStore();
    await expect(store.save({ source: { kind: "data_url", dataUrl } })).rejects.toThrow();
    expect(fileSystem.files.size).toBe(0);
  });

  it("copies file URI images without altering the source", async () => {
    const { fileSystem, store } = createStore();
    const bytes = new Uint8Array([0, 1, 254, 255]);
    fileSystem.setFile("file:///keyboard/image.png", bytes);
    const attachment = await store.save({
      id: "keyboard",
      mimeType: "image/png",
      source: { kind: "file_uri", uri: "file:///keyboard/image.png" },
    });

    expect(fileSystem.files.get("file:///cache/preview-assets/keyboard.png")).toEqual(bytes);
    expect(fileSystem.files.get("file:///keyboard/image.png")).toEqual(bytes);
    expect(attachment.byteSize).toBe(bytes.length);
  });

  it("writes raw byte sources directly to the managed file path", async () => {
    const { fileSystem, store } = createStore();

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

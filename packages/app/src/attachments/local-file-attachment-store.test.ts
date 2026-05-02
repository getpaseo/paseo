import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalFileAttachmentStore } from "./local-file-attachment-store";

const fileSystemMock = vi.hoisted(() => ({
  getInfoAsync: vi.fn(async (uri: string) => {
    if (uri.endsWith("/preview-assets/")) {
      return { exists: true, isDirectory: true };
    }
    return { exists: true, isDirectory: false, size: 4 };
  }),
  makeDirectoryAsync: vi.fn(async () => {}),
  writeAsStringAsync: vi.fn(async () => {}),
  copyAsync: vi.fn(async () => {}),
  readAsStringAsync: vi.fn(async () => "AAECAw=="),
  deleteAsync: vi.fn(async () => {}),
  readDirectoryAsync: vi.fn(async () => []),
  fileWrite: vi.fn((_uri: string, _content: Uint8Array) => {}),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    write(content: Uint8Array) {
      fileSystemMock.fileWrite(this.uri, content);
    }
  },
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  getInfoAsync: fileSystemMock.getInfoAsync,
  makeDirectoryAsync: fileSystemMock.makeDirectoryAsync,
  writeAsStringAsync: fileSystemMock.writeAsStringAsync,
  copyAsync: fileSystemMock.copyAsync,
  readAsStringAsync: fileSystemMock.readAsStringAsync,
  deleteAsync: fileSystemMock.deleteAsync,
  readDirectoryAsync: fileSystemMock.readDirectoryAsync,
}));

describe("local file attachment store", () => {
  beforeEach(() => {
    fileSystemMock.getInfoAsync.mockClear();
    fileSystemMock.makeDirectoryAsync.mockClear();
    fileSystemMock.writeAsStringAsync.mockClear();
    fileSystemMock.copyAsync.mockClear();
    fileSystemMock.readAsStringAsync.mockClear();
    fileSystemMock.deleteAsync.mockClear();
    fileSystemMock.readDirectoryAsync.mockClear();
    fileSystemMock.fileWrite.mockClear();
  });

  it("writes raw byte sources directly to the managed file path", async () => {
    const store = createLocalFileAttachmentStore({
      storageType: "native-file",
      baseDirectoryName: "preview-assets",
      resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
    });

    const attachment = await store.save({
      id: "preview_8_test",
      mimeType: "image/png",
      fileName: "result.png",
      source: { kind: "bytes", bytes: new Uint8Array([0, 1, 2, 3]) },
    });

    expect(fileSystemMock.fileWrite).toHaveBeenCalledWith(
      "file:///cache/preview-assets/preview_8_test.png",
      new Uint8Array([0, 1, 2, 3]),
    );
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalled();
    expect(attachment).toMatchObject({
      id: "preview_8_test",
      mimeType: "image/png",
      storageType: "native-file",
      storageKey: "/cache/preview-assets/preview_8_test.png",
      fileName: "result.png",
      byteSize: 4,
    });
  });
});

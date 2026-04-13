import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopAttachmentStore } from "./desktop-attachment-store";

const {
  copyDesktopAttachmentFileMock,
  writeDesktopAttachmentBase64Mock,
  deleteDesktopAttachmentFileMock,
  garbageCollectDesktopAttachmentFilesMock,
  readDesktopFileBase64Mock,
  resolveDesktopPreviewUrlMock,
  releaseDesktopPreviewUrlMock,
} = vi.hoisted(() => ({
  copyDesktopAttachmentFileMock: vi.fn(async () => ({
    path: "/managed/att_1.png",
    byteSize: 4,
  })),
  writeDesktopAttachmentBase64Mock: vi.fn(async () => ({
    path: "/managed/att_2.png",
    byteSize: 4,
  })),
  deleteDesktopAttachmentFileMock: vi.fn(async () => true),
  garbageCollectDesktopAttachmentFilesMock: vi.fn(async () => 0),
  readDesktopFileBase64Mock: vi.fn(async () => "AAECAw=="),
  resolveDesktopPreviewUrlMock: vi.fn(async () => "blob:test"),
  releaseDesktopPreviewUrlMock: vi.fn(async () => {}),
}));

vi.mock("./desktop-file-commands", () => ({
  copyDesktopAttachmentFile: copyDesktopAttachmentFileMock,
  writeDesktopAttachmentBase64: writeDesktopAttachmentBase64Mock,
  deleteDesktopAttachmentFile: deleteDesktopAttachmentFileMock,
  garbageCollectDesktopAttachmentFiles: garbageCollectDesktopAttachmentFilesMock,
}));

vi.mock("./desktop-preview-url", () => ({
  readDesktopFileBase64: readDesktopFileBase64Mock,
  resolveDesktopPreviewUrl: resolveDesktopPreviewUrlMock,
  releaseDesktopPreviewUrl: releaseDesktopPreviewUrlMock,
}));

describe("desktop attachment store", () => {
  beforeEach(() => {
    copyDesktopAttachmentFileMock.mockClear();
    writeDesktopAttachmentBase64Mock.mockClear();
    deleteDesktopAttachmentFileMock.mockClear();
    garbageCollectDesktopAttachmentFilesMock.mockClear();
    readDesktopFileBase64Mock.mockClear();
    resolveDesktopPreviewUrlMock.mockClear();
    releaseDesktopPreviewUrlMock.mockClear();
  });

  it("saves dropped file paths as desktop-file metadata", async () => {
    const store = createDesktopAttachmentStore();
    const attachment = await store.save({
      id: "att_1",
      mimeType: "image/png",
      source: {
        kind: "file_uri",
        uri: "file:///Users/test/Desktop/image.png",
      },
    });

    expect(copyDesktopAttachmentFileMock).toHaveBeenCalledWith({
      attachmentId: "att_1",
      sourcePath: "/Users/test/Desktop/image.png",
      extension: ".png",
    });
    expect(attachment.storageType).toBe("desktop-file");
    expect(attachment.storageKey).toBe("/managed/att_1.png");
  });

  it("saves blob/data-url sources via desktop filesystem writes", async () => {
    const store = createDesktopAttachmentStore();
    await store.save({
      id: "att_2",
      source: {
        kind: "data_url",
        dataUrl: "data:image/png;base64,AAECAw==",
      },
    });

    expect(writeDesktopAttachmentBase64Mock).toHaveBeenCalledWith({
      attachmentId: "att_2",
      base64: "AAECAw==",
      extension: ".png",
    });
  });

  it("delegates encode/preview/delete/gc to desktop command path", async () => {
    const store = createDesktopAttachmentStore();
    const attachment = {
      id: "att_3",
      mimeType: "image/jpeg",
      storageType: "desktop-file" as const,
      storageKey: "/managed/att_3.jpg",
      createdAt: Date.now(),
    };

    await store.encodeBase64({ attachment });
    await store.resolvePreviewUrl({ attachment });
    await store.releasePreviewUrl?.({ attachment, url: "blob:test" });
    await store.delete({ attachment });
    await store.garbageCollect({ referencedIds: new Set(["att_3"]) });

    expect(readDesktopFileBase64Mock).toHaveBeenCalledWith("/managed/att_3.jpg");
    expect(resolveDesktopPreviewUrlMock).toHaveBeenCalled();
    expect(releaseDesktopPreviewUrlMock).toHaveBeenCalledWith({ url: "blob:test" });
    expect(deleteDesktopAttachmentFileMock).toHaveBeenCalledWith({
      path: "/managed/att_3.jpg",
    });
    expect(garbageCollectDesktopAttachmentFilesMock).toHaveBeenCalledWith({
      referencedIds: ["att_3"],
    });
  });
});

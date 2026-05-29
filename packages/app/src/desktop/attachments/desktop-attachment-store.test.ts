import { describe, expect, it } from "vitest";
import { createDesktopAttachmentStore } from "./desktop-attachment-store";
import { createFakeDesktopAttachmentBridge } from "./test-utils/fake-desktop-attachment-bridge";

describe("desktop attachment store", () => {
  it("saves dropped file paths as desktop-file metadata", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);

    const attachment = await store.save({
      id: "att_1",
      mimeType: "image/png",
      source: {
        kind: "file_uri",
        uri: "file:///Users/test/Desktop/image.png",
      },
    });

    expect(fake.savedEntries).toEqual([
      {
        attachmentId: "att_1",
        path: "/managed/att_1.png",
        byteSize: 4,
        extension: ".png",
        source: { kind: "copy", sourcePath: "/Users/test/Desktop/image.png" },
      },
    ]);
    expect(attachment).toMatchObject({
      storageType: "desktop-file",
      storageKey: "/managed/att_1.png",
    });
  });

  it("saves blob/data-url sources via desktop filesystem writes", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);

    await store.save({
      id: "att_2",
      source: {
        kind: "data_url",
        dataUrl: "data:image/png;base64,AAECAw==",
      },
    });

    expect(fake.savedEntries).toEqual([
      {
        attachmentId: "att_2",
        path: "/managed/att_2.png",
        byteSize: 4,
        extension: ".png",
        source: { kind: "base64", base64: "AAECAw==" },
      },
    ]);
  });

  it("saves raw byte sources via desktop filesystem writes", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await store.save({
      id: "att_bytes",
      mimeType: "image/png",
      fileName: "inline.png",
      source: {
        kind: "bytes",
        bytes,
      },
    });

    expect(fake.savedEntries).toEqual([
      {
        attachmentId: "att_bytes",
        path: "/managed/att_bytes.png",
        byteSize: 4,
        extension: ".png",
        source: { kind: "bytes", bytes },
      },
    ]);
    expect(attachment).toMatchObject({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "desktop-file",
      storageKey: "/managed/att_bytes.png",
      fileName: "inline.png",
      byteSize: 4,
    });
  });

  it("delegates encode/preview/delete/gc to desktop command path", async () => {
    const fake = createFakeDesktopAttachmentBridge();
    const store = createDesktopAttachmentStore(fake.bridge);
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

    expect(fake.readBase64Calls).toEqual(["/managed/att_3.jpg"]);
    expect(fake.resolvedPreviewUrls).toEqual([attachment]);
    expect(fake.releasedPreviewUrls).toEqual(["blob:test"]);
    expect(fake.deletedPaths).toEqual(["/managed/att_3.jpg"]);
    expect(fake.garbageCollections).toEqual([{ referencedIds: ["att_3"] }]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata, AttachmentStore, SaveAttachmentInput } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "./store";
import {
  encodeAttachmentsForSend,
  garbageCollectAttachments,
  persistAttachmentFromBytes,
  uploadImageAttachments,
} from "./service";

function createAttachment(input: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: input.id ?? "att_1",
    mimeType: input.mimeType ?? "image/png",
    storageType: input.storageType ?? "web-indexeddb",
    storageKey: input.storageKey ?? "att_1",
    fileName: input.fileName,
    byteSize: input.byteSize,
    createdAt: input.createdAt ?? 1700000000000,
  };
}

function createRecordingStore(): AttachmentStore & {
  savedSources: SaveAttachmentInput[];
  releasedUrls: string[];
} {
  const savedSources: SaveAttachmentInput[] = [];
  const releasedUrls: string[] = [];

  return {
    storageType: "web-indexeddb",
    savedSources,
    releasedUrls,
    async save(input) {
      savedSources.push(input);
      return createAttachment({
        id: input.id,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteSize: 4,
      });
    },
    async encodeBase64({ attachment }) {
      return `${attachment.id}:base64`;
    },
    async readBytes({ attachment }) {
      return new TextEncoder().encode(`${attachment.id}:bytes`);
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async releasePreviewUrl({ url }) {
      releasedUrls.push(url);
    },
    async delete() {},
    async garbageCollect() {},
  };
}

describe("attachment service", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
  });

  it("persists raw bytes without requiring a base64 wrapper", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await persistAttachmentFromBytes({
      id: "att_bytes",
      bytes,
      mimeType: "image/png",
      fileName: "image.png",
    });

    expect(attachment).toEqual({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_1",
      fileName: "image.png",
      byteSize: 4,
      createdAt: 1700000000000,
    });
    expect(store.savedSources).toEqual([
      {
        id: "att_bytes",
        mimeType: "image/png",
        fileName: "image.png",
        source: { kind: "bytes", bytes },
      },
    ]);
  });

  it("keeps provider send output byte-compatible", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const attachment = createAttachment({ id: "att_send", mimeType: "image/jpeg" });

    await expect(encodeAttachmentsForSend([attachment])).resolves.toEqual([
      { data: "att_send:base64", mimeType: "image/jpeg" },
    ]);
  });

  it("does not collect an attachment persisted while garbage collection is starting", async () => {
    let releaseSave: () => void = () => undefined;
    let reportSaveStarted: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const garbageCollections: string[][] = [];
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async save(input) {
        reportSaveStarted();
        await saveGate;
        return createAttachment({ id: input.id });
      },
      async garbageCollect({ referencedIds }) {
        garbageCollections.push([...referencedIds]);
      },
    };
    __setAttachmentStoreForTests(store);

    const persist = persistAttachmentFromBytes({
      id: "assistant-preview",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });
    await saveStarted;
    const collect = garbageCollectAttachments({ referencedIds: new Set() });

    try {
      await Promise.resolve();
      expect(garbageCollections).toEqual([]);
    } finally {
      releaseSave();
      await Promise.all([persist, collect]);
    }

    expect(garbageCollections).toEqual([["assistant-preview"]]);
  });

  it("uploads image attachments sequentially via uploadFile without inlining base64", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);

    const events: string[] = [];
    const firstGate = (() => {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    const client = {
      uploadFile: async (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => {
        events.push(`start:${input.fileName}`);
        if (input.fileName === "first.jpg") {
          await firstGate.promise;
        }
        events.push(`end:${input.fileName}`);
        return {
          requestId: `req-${input.fileName}`,
          file: {
            type: "uploaded_file" as const,
            id: `upload_${input.fileName}`,
            fileName: input.fileName,
            mimeType: input.mimeType,
            size: input.bytes.byteLength,
            path: `/home/user/.paseo/uploads/upload_${input.fileName}/${input.fileName}`,
          },
          error: null,
        };
      },
    };

    const uploadPromise = uploadImageAttachments({
      client,
      images: [
        createAttachment({ id: "img-1", fileName: "first.jpg", mimeType: "image/jpeg" }),
        createAttachment({ id: "img-2", fileName: "second.png", mimeType: "image/png" }),
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    // Second photo must NOT start uploading until first photo's response has resolved.
    expect(events).toEqual(["start:first.jpg"]);
    firstGate.release();

    const uploaded = await uploadPromise;
    expect(events).toEqual([
      "start:first.jpg",
      "end:first.jpg",
      "start:second.png",
      "end:second.png",
    ]);
    expect(uploaded).toEqual([
      {
        type: "uploaded_file",
        id: "upload_first.jpg",
        fileName: "first.jpg",
        mimeType: "image/jpeg",
        size: new TextEncoder().encode("img-1:bytes").byteLength,
        path: "/home/user/.paseo/uploads/upload_first.jpg/first.jpg",
        role: "image",
      },
      {
        type: "uploaded_file",
        id: "upload_second.png",
        fileName: "second.png",
        mimeType: "image/png",
        size: new TextEncoder().encode("img-2:bytes").byteLength,
        path: "/home/user/.paseo/uploads/upload_second.png/second.png",
        role: "image",
      },
    ]);
  });
});

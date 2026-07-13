import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata, AttachmentStore, SaveAttachmentInput } from "@/attachments/types";
import { AttachmentTooLargeError, IMAGE_COMPRESS_TRIGGER_BASE64_CHARS } from "./image-compression";
import { __setAttachmentStoreForTests } from "./store";
import {
  __setImageCompressorForTests,
  encodeAttachmentsForSend,
  persistAttachmentFromBytes,
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
    __setImageCompressorForTests(null);
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

  it("compresses oversized images through the injected compressor", async () => {
    const store = createRecordingStore();
    const big = "x".repeat(IMAGE_COMPRESS_TRIGGER_BASE64_CHARS + 10);
    store.encodeBase64 = async () => big;
    __setAttachmentStoreForTests(store);

    const compress = vi.fn(async () => ({ data: "compressed", mimeType: "image/jpeg" }));
    __setImageCompressorForTests(compress);

    const attachment = createAttachment({ id: "att_big", mimeType: "image/png" });
    await expect(encodeAttachmentsForSend([attachment])).resolves.toEqual([
      { data: "compressed", mimeType: "image/jpeg" },
    ]);
    expect(compress).toHaveBeenCalledOnce();
    expect(store.releasedUrls).toEqual(["blob:att_big"]);
  });

  it("throws AttachmentTooLargeError when an image stays over budget", async () => {
    const store = createRecordingStore();
    const big = "x".repeat(IMAGE_COMPRESS_TRIGGER_BASE64_CHARS + 10);
    store.encodeBase64 = async () => big.repeat(3);
    __setAttachmentStoreForTests(store);
    __setImageCompressorForTests(async () => null);

    const attachment = createAttachment({ id: "att_huge", mimeType: "image/png" });
    await expect(encodeAttachmentsForSend([attachment])).rejects.toBeInstanceOf(
      AttachmentTooLargeError,
    );
  });
});

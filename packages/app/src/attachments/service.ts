import type { AttachmentMetadata } from "@/attachments/types";
import { getAttachmentStore } from "@/attachments/store";
import {
  encodeAttachmentsToBudget,
  type EncodedAttachment,
  type ImageCompressor,
} from "@/attachments/image-compression";

let compressorOverride: ImageCompressor | null = null;

/** Test-only hook to inject a deterministic image compressor. */
export function __setImageCompressorForTests(compressor: ImageCompressor | null): void {
  compressorOverride = compressor;
}

const lazyImageCompressor: ImageCompressor = async (input) => {
  if (compressorOverride) return compressorOverride(input);
  const mod = await import("@/attachments/image-compressor");
  return mod.compressImage(input);
};

export async function persistAttachmentFromBlob(input: {
  blob: Blob;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "blob", blob: input.blob },
  });
}

export async function persistAttachmentFromDataUrl(input: {
  dataUrl: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "data_url", dataUrl: input.dataUrl },
  });
}

export async function persistAttachmentFromBytes(input: {
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "bytes", bytes: input.bytes },
  });
}

export async function persistAttachmentFromFileUri(input: {
  uri: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  const store = await getAttachmentStore();
  return await store.save({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "file_uri", uri: input.uri },
  });
}

export async function encodeAttachmentsForSend(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<EncodedAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const store = await getAttachmentStore();
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const encoded = await encodeAttachmentsToBudget(
    attachments.map((attachment) => ({ id: attachment.id, mimeType: attachment.mimeType })),
    {
      encodeBase64: (id) => store.encodeBase64({ attachment: byId.get(id)! }),
      resolvePreviewUrl: (id) => store.resolvePreviewUrl({ attachment: byId.get(id)! }),
      releasePreviewUrl: store.releasePreviewUrl
        ? (id, url) => store.releasePreviewUrl!({ attachment: byId.get(id)!, url })
        : undefined,
      compress: lazyImageCompressor,
    },
  );

  return encoded.length > 0 ? encoded : undefined;
}

export async function resolveAttachmentPreviewUrl(attachment: AttachmentMetadata): Promise<string> {
  const store = await getAttachmentStore();
  return await store.resolvePreviewUrl({ attachment });
}

export async function releaseAttachmentPreviewUrl(input: {
  attachment: AttachmentMetadata;
  url: string;
}): Promise<void> {
  const store = await getAttachmentStore();
  if (!store.releasePreviewUrl) {
    return;
  }
  await store.releasePreviewUrl({ attachment: input.attachment, url: input.url });
}

export async function deleteAttachments(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) {
    return;
  }
  const store = await getAttachmentStore();
  await Promise.all(
    attachments.map(async (attachment) => {
      try {
        await store.delete({ attachment });
      } catch (error) {
        console.warn("[attachments] Failed to delete attachment", {
          id: attachment.id,
          error,
        });
      }
    }),
  );
}

export async function garbageCollectAttachments(input: {
  referencedIds: ReadonlySet<string>;
}): Promise<void> {
  const store = await getAttachmentStore();
  await store.garbageCollect({ referencedIds: input.referencedIds });
}

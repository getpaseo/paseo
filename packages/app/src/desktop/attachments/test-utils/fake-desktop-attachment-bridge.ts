import type { AttachmentMetadata } from "@/attachments/types";
import type {
  DesktopAttachmentBridge,
  DesktopAttachmentFileResult,
} from "@/desktop/attachments/desktop-attachment-bridge";

export interface FakeDesktopAttachmentEntry {
  attachmentId: string;
  path: string;
  byteSize: number;
  extension: string | null;
  source:
    | { kind: "copy"; sourcePath: string }
    | { kind: "base64"; base64: string }
    | { kind: "bytes"; bytes: Uint8Array };
}

export interface FakeDesktopAttachmentBridge {
  bridge: DesktopAttachmentBridge;
  savedEntries: FakeDesktopAttachmentEntry[];
  deletedPaths: string[];
  garbageCollections: Array<{ referencedIds: readonly string[] }>;
  readBase64Calls: string[];
  resolvedPreviewUrls: AttachmentMetadata[];
  releasedPreviewUrls: string[];
}

export function createFakeDesktopAttachmentBridge(): FakeDesktopAttachmentBridge {
  const savedEntries: FakeDesktopAttachmentEntry[] = [];
  const deletedPaths: string[] = [];
  const garbageCollections: Array<{ referencedIds: readonly string[] }> = [];
  const readBase64Calls: string[] = [];
  const resolvedPreviewUrls: AttachmentMetadata[] = [];
  const releasedPreviewUrls: string[] = [];

  function buildPath(attachmentId: string, extension: string | null | undefined): string {
    return `/managed/${attachmentId}${extension ?? ""}`;
  }

  function record(entry: FakeDesktopAttachmentEntry): DesktopAttachmentFileResult {
    savedEntries.push(entry);
    return { path: entry.path, byteSize: entry.byteSize };
  }

  const bridge: DesktopAttachmentBridge = {
    async copyFile({ attachmentId, sourcePath, extension }) {
      return record({
        attachmentId,
        path: buildPath(attachmentId, extension),
        byteSize: 4,
        extension: extension ?? null,
        source: { kind: "copy", sourcePath },
      });
    },
    async writeBase64({ attachmentId, base64, extension }) {
      return record({
        attachmentId,
        path: buildPath(attachmentId, extension),
        byteSize: 4,
        extension: extension ?? null,
        source: { kind: "base64", base64 },
      });
    },
    async writeBytes({ attachmentId, bytes, extension }) {
      return record({
        attachmentId,
        path: buildPath(attachmentId, extension),
        byteSize: bytes.byteLength,
        extension: extension ?? null,
        source: { kind: "bytes", bytes },
      });
    },
    async deleteFile({ path }) {
      deletedPaths.push(path);
      return true;
    },
    async garbageCollect({ referencedIds }) {
      garbageCollections.push({ referencedIds });
      return 0;
    },
    async readFileBase64(path) {
      readBase64Calls.push(path);
      return "AAECAw==";
    },
    async resolvePreviewUrl(attachment) {
      resolvedPreviewUrls.push(attachment);
      return "blob:test";
    },
    async releasePreviewUrl({ url }) {
      releasedPreviewUrls.push(url);
    },
  };

  return {
    bridge,
    savedEntries,
    deletedPaths,
    garbageCollections,
    readBase64Calls,
    resolvedPreviewUrls,
    releasedPreviewUrls,
  };
}

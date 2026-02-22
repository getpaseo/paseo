import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import {
  blobToBase64,
  fileUriToPath,
  generateAttachmentId,
  getFileExtensionFromName,
  normalizeMimeType,
  parseDataUrl,
} from "@/attachments/utils";
import {
  copyDesktopAttachmentFile,
  deleteDesktopAttachmentFile,
  garbageCollectDesktopAttachmentFiles,
  writeDesktopAttachmentBase64,
} from "@/desktop/attachments/desktop-file-commands";
import {
  readDesktopFileBase64,
  releaseDesktopPreviewUrl,
  resolveDesktopPreviewUrl,
} from "@/desktop/attachments/desktop-preview-url";

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

function inferFileNameFromPath(path: string): string | null {
  const normalizedPath = path.replace(/\\/g, "/");
  const parts = normalizedPath.split("/");
  const lastPart = parts[parts.length - 1];
  return lastPart && lastPart.length > 0 ? lastPart : null;
}

function extensionForAttachment(input: {
  fileName?: string | null;
  sourcePath?: string | null;
  mimeType: string;
}): string {
  const fromName = getFileExtensionFromName(input.fileName);
  if (fromName) {
    return fromName;
  }

  const fromSourcePath = getFileExtensionFromName(input.sourcePath);
  if (fromSourcePath) {
    return fromSourcePath;
  }

  return IMAGE_EXTENSION_BY_MIME_TYPE[input.mimeType] ?? ".img";
}

function toDesktopMetadata(input: {
  id: string;
  mimeType: string;
  storagePath: string;
  byteSize: number;
  fileName?: string | null;
}): AttachmentMetadata {
  return {
    id: input.id,
    mimeType: input.mimeType,
    storageType: "desktop-file",
    storageKey: input.storagePath,
    fileName: input.fileName ?? null,
    byteSize: input.byteSize,
    createdAt: Date.now(),
  };
}

async function saveDesktopAttachmentFromFileUri(input: {
  id: string;
  uri: string;
  mimeType?: string;
  fileName?: string | null;
}): Promise<AttachmentMetadata> {
  const sourcePath = fileUriToPath(input.uri);
  const fileName = input.fileName ?? inferFileNameFromPath(sourcePath);
  const mimeType = normalizeMimeType(input.mimeType);
  const extension = extensionForAttachment({
    fileName,
    sourcePath,
    mimeType,
  });

  const result = await copyDesktopAttachmentFile({
    attachmentId: input.id,
    sourcePath,
    extension,
  });

  return toDesktopMetadata({
    id: input.id,
    mimeType,
    storagePath: result.path,
    byteSize: result.byteSize,
    fileName,
  });
}

async function saveDesktopAttachmentFromBase64(input: {
  id: string;
  base64: string;
  mimeType: string;
  fileName?: string | null;
}): Promise<AttachmentMetadata> {
  const extension = extensionForAttachment({
    fileName: input.fileName,
    mimeType: input.mimeType,
  });

  const result = await writeDesktopAttachmentBase64({
    attachmentId: input.id,
    base64: input.base64,
    extension,
  });

  return toDesktopMetadata({
    id: input.id,
    mimeType: input.mimeType,
    storagePath: result.path,
    byteSize: result.byteSize,
    fileName: input.fileName,
  });
}

function assertDesktopAttachment(attachment: AttachmentMetadata): void {
  if (attachment.storageType !== "desktop-file") {
    throw new Error(
      `Unsupported desktop attachment storage type '${attachment.storageType}'.`
    );
  }
}

export function createDesktopAttachmentStore(): AttachmentStore {
  return {
    storageType: "desktop-file",

    async save(input): Promise<AttachmentMetadata> {
      const id = input.id ?? generateAttachmentId();
      const fileName = input.fileName ?? null;

      if (input.source.kind === "file_uri") {
        return await saveDesktopAttachmentFromFileUri({
          id,
          uri: input.source.uri,
          mimeType: input.mimeType,
          fileName,
        });
      }

      if (input.source.kind === "data_url") {
        const parsed = parseDataUrl(input.source.dataUrl);
        const mimeType = normalizeMimeType(input.mimeType ?? parsed.mimeType);
        return await saveDesktopAttachmentFromBase64({
          id,
          base64: parsed.base64,
          mimeType,
          fileName,
        });
      }

      const mimeType = normalizeMimeType(input.mimeType ?? input.source.blob.type);
      const base64 = await blobToBase64(input.source.blob);
      return await saveDesktopAttachmentFromBase64({
        id,
        base64,
        mimeType,
        fileName,
      });
    },

    async encodeBase64({ attachment }): Promise<string> {
      assertDesktopAttachment(attachment);
      return await readDesktopFileBase64(attachment.storageKey);
    },

    async resolvePreviewUrl({ attachment }): Promise<string> {
      assertDesktopAttachment(attachment);
      return await resolveDesktopPreviewUrl(attachment);
    },

    async releasePreviewUrl({ attachment, url }): Promise<void> {
      assertDesktopAttachment(attachment);
      await releaseDesktopPreviewUrl({ url });
    },

    async delete({ attachment }): Promise<void> {
      assertDesktopAttachment(attachment);
      await deleteDesktopAttachmentFile({ path: attachment.storageKey });
    },

    async garbageCollect({ referencedIds }): Promise<void> {
      await garbageCollectDesktopAttachmentFiles({
        referencedIds: Array.from(referencedIds),
      });
    },
  };
}

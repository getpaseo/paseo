import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import {
  type AttachmentStore,
  type AttachmentStorageType,
  type AttachmentMetadata,
  type SaveAttachmentInput,
} from "@/attachments/types";
import {
  fileUriToPath,
  generateAttachmentId,
  getFileExtensionFromName,
  normalizeMimeType,
  parseDataUrl,
  pathToFileUri,
} from "@/attachments/utils";

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

function extensionForAttachment(params: { fileName?: string | null; mimeType: string }): string {
  const fromName = getFileExtensionFromName(params.fileName);
  if (fromName) {
    return fromName;
  }
  return IMAGE_EXTENSION_BY_MIME_TYPE[params.mimeType] ?? ".img";
}

async function ensureDirectory(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (info.exists && info.isDirectory) {
    return;
  }
  await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const response = await fetch(dataUrl);
  return new Uint8Array(await response.arrayBuffer());
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function writeFromSource(input: {
  source: SaveAttachmentInput["source"];
  targetUri: string;
  mimeType: string;
}): Promise<void> {
  if (input.source.kind === "file_uri") {
    const from = pathToFileUri(input.source.uri);
    if (from === input.targetUri) {
      return;
    }
    await FileSystem.copyAsync({ from, to: input.targetUri });
    return;
  }

  let bytes: Uint8Array;
  if (input.source.kind === "data_url") {
    bytes = await dataUrlToBytes(input.source.dataUrl);
  } else if (input.source.kind === "blob") {
    bytes = await blobToBytes(input.source.blob);
  } else {
    bytes = input.source.bytes;
  }

  new File(input.targetUri).write(bytes);
}

function attachmentUri(metadata: AttachmentMetadata): string {
  return pathToFileUri(metadata.storageKey);
}

export function createLocalFileAttachmentStore(params: {
  storageType: Extract<AttachmentStorageType, "desktop-file" | "native-file">;
  baseDirectoryName: string;
  resolvePreviewUrl: (attachment: AttachmentMetadata) => Promise<string>;
  releasePreviewUrl?: (input: { attachment: AttachmentMetadata; url: string }) => Promise<void>;
}): AttachmentStore {
  const baseDirectory = FileSystem.cacheDirectory
    ? `${FileSystem.cacheDirectory}${params.baseDirectoryName}/`
    : null;

  async function resolveTarget(input: SaveAttachmentInput): Promise<{
    id: string;
    mimeType: string;
    fileName: string | null;
    createdAt: number;
    targetUri: string;
    storageKey: string;
  }> {
    if (!baseDirectory) {
      throw new Error("expo-file-system cacheDirectory is unavailable.");
    }

    await ensureDirectory(baseDirectory);

    const id = input.id ?? generateAttachmentId();
    let mimeTypeFromSource: string | undefined;
    if (input.source.kind === "data_url") {
      mimeTypeFromSource = parseDataUrl(input.source.dataUrl).mimeType;
    } else if (input.source.kind === "blob") {
      mimeTypeFromSource = input.source.blob.type;
    } else {
      mimeTypeFromSource = undefined;
    }
    const mimeType = normalizeMimeType(input.mimeType ?? mimeTypeFromSource);
    const fileName = input.fileName ?? null;
    const extension = extensionForAttachment({ fileName, mimeType });
    const createdAt = Date.now();
    const targetUri = `${baseDirectory}${id}${extension}`;
    const storageKey = fileUriToPath(targetUri);

    return {
      id,
      mimeType,
      fileName,
      createdAt,
      targetUri,
      storageKey,
    };
  }

  return {
    storageType: params.storageType,

    async save(input): Promise<AttachmentMetadata> {
      const target = await resolveTarget(input);
      await writeFromSource({
        source: input.source,
        targetUri: target.targetUri,
        mimeType: target.mimeType,
      });

      const info = await FileSystem.getInfoAsync(target.targetUri);
      const byteSize =
        info.exists && typeof (info as { size?: number }).size === "number"
          ? (info as { size: number }).size
          : null;
      return {
        id: target.id,
        mimeType: target.mimeType,
        storageType: params.storageType,
        storageKey: target.storageKey,
        fileName: target.fileName,
        byteSize,
        createdAt: target.createdAt,
      };
    },

    async encodeBase64({ attachment }): Promise<string> {
      const uri = attachmentUri(attachment);
      return await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    },

    async resolvePreviewUrl({ attachment }): Promise<string> {
      return await params.resolvePreviewUrl(attachment);
    },

    ...(params.releasePreviewUrl
      ? {
          async releasePreviewUrl(input: {
            attachment: AttachmentMetadata;
            url: string;
          }): Promise<void> {
            await params.releasePreviewUrl?.(input);
          },
        }
      : {}),

    async delete({ attachment }): Promise<void> {
      await FileSystem.deleteAsync(attachmentUri(attachment), { idempotent: true });
    },

    async garbageCollect({ referencedIds }): Promise<void> {
      if (!baseDirectory) {
        return;
      }
      await ensureDirectory(baseDirectory);
      const entries = await FileSystem.readDirectoryAsync(baseDirectory);
      await Promise.all(
        entries.map(async (entryName) => {
          const id = entryName.split(".", 1)[0] ?? "";
          if (!id || referencedIds.has(id)) {
            return;
          }
          await FileSystem.deleteAsync(`${baseDirectory}${entryName}`, {
            idempotent: true,
          });
        }),
      );
    },
  };
}

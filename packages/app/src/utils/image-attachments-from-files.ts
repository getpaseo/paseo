import type { AttachmentMetadata } from "@/attachments/types";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { resolveRasterImageMimeType } from "@/attachments/file-types";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}

export type ImageAttachmentFromFile = AttachmentMetadata;

export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

export function collectImageFilesFromClipboardData(
  clipboardData?: ClipboardDataLike | null,
): ClipboardImageFile[] {
  if (!clipboardData?.items) {
    return [];
  }

  const files: ClipboardImageFile[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item?.kind !== "file") {
      continue;
    }
    const mimeType = resolveRasterImageMimeType({ mimeType: item.type });
    if (!mimeType) {
      continue;
    }
    const file = item.getAsFile?.();
    if (!file) {
      continue;
    }
    files.push({ file, mimeType });
  }

  return files;
}

export async function filesToImageAttachments(
  files: readonly ClipboardImageFile[],
): Promise<ImageAttachmentFromFile[]> {
  const attachments = await Promise.all(
    files.map(async ({ file, mimeType }) => {
      try {
        return await persistAttachmentFromBlob({
          blob: file,
          mimeType,
          fileName: file.name,
        });
      } catch (error) {
        console.error("[attachments] Failed to persist file attachment", {
          fileName: file.name,
          error,
        });
        return null;
      }
    }),
  );

  return attachments.filter((entry): entry is ImageAttachmentFromFile => entry !== null);
}

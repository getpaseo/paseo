import type { AttachmentMetadata } from "@/attachments/types";
import { persistAttachmentFromBlob } from "@/attachments/service";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}

export type ImageAttachmentFromFile = AttachmentMetadata;

export function collectImageFilesFromClipboardData(
  clipboardData?: ClipboardDataLike | null
): File[] {
  if (!clipboardData?.items) {
    return [];
  }

  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item?.kind !== "file") {
      continue;
    }
    if (!item.type?.startsWith("image/")) {
      continue;
    }
    const file = item.getAsFile?.();
    if (!file) {
      continue;
    }
    files.push(file);
  }

  return files;
}

export async function filesToImageAttachments(
  files: readonly File[]
): Promise<ImageAttachmentFromFile[]> {
  const attachments = await Promise.all(
    files.map(async (file) => {
      try {
        return await persistAttachmentFromBlob({
          blob: file,
          mimeType: file.type || "image/jpeg",
          fileName: file.name,
        });
      } catch (error) {
        console.error("[attachments] Failed to persist file attachment", {
          fileName: file.name,
          error,
        });
        return null;
      }
    })
  );

  return attachments.filter(
    (entry): entry is ImageAttachmentFromFile => entry !== null
  );
}

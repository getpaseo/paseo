import { resolveRasterImageMimeType } from "@/attachments/file-types";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

export interface NativePastedFile {
  fileName: string;
  fileSize: number;
  type: string;
  uri: string;
}

export class UnsupportedPastedImageError extends Error {
  constructor(fileName: string) {
    super(`Unsupported pasted image '${fileName}'.`);
    this.name = "UnsupportedPastedImageError";
  }
}

export function normalizeNativePastedImages(
  files: readonly NativePastedFile[],
): PickedImageAttachmentInput[] {
  return files.map((file) => {
    const mimeType = resolveRasterImageMimeType({
      mimeType: file.type,
      path: file.fileName,
    });
    if (!mimeType) {
      throw new UnsupportedPastedImageError(file.fileName);
    }
    return {
      source: { kind: "file_uri", uri: file.uri },
      mimeType,
      fileName: file.fileName,
    };
  });
}

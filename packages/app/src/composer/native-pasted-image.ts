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

export async function resolveNativePasteImages(input: {
  files: readonly NativePastedFile[];
  readClipboardImage: () => Promise<PickedImageAttachmentInput | null>;
}): Promise<PickedImageAttachmentInput[]> {
  try {
    const fromFiles = normalizeNativePastedImages(input.files);
    if (fromFiles.length > 0) {
      return fromFiles;
    }
  } catch {
    // Native paste often reports a UTI we cannot persist. The clipboard reader
    // handles more image representations, including iOS screenshot pastes.
  }

  const image = await input.readClipboardImage();
  return image ? [image] : [];
}

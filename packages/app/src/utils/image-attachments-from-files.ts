export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}

export interface ImageAttachmentFromFile {
  uri: string;
  mimeType: string;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

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
  return Promise.all(
    files.map(async (file) => {
      const mimeType = file.type || "image/jpeg";
      const base64 = toBase64(await file.arrayBuffer());
      return {
        uri: `data:${mimeType};base64,${base64}`,
        mimeType,
      };
    })
  );
}

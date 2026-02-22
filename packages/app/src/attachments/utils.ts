import { generateMessageId } from "@/types/stream";

export function generateAttachmentId(): string {
  return `att_${generateMessageId()}`;
}

export function normalizeMimeType(input: string | undefined | null): string {
  if (!input) {
    return "image/jpeg";
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : "image/jpeg";
}

export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Malformed data URL for attachment.");
  }
  const [, mimeTypeRaw, base64] = match;
  if (!base64) {
    throw new Error("Attachment data URL is missing base64 payload.");
  }
  return {
    mimeType: normalizeMimeType(mimeTypeRaw),
    base64,
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected FileReader result while encoding attachment."));
        return;
      }
      const payload = reader.result.split(",", 2)[1];
      if (!payload) {
        reject(new Error("Attachment FileReader result did not contain base64 payload."));
        return;
      }
      resolve(payload);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read attachment blob."));
    };
    reader.readAsDataURL(blob);
  });
}

export function pathToFileUri(path: string): string {
  if (path.startsWith("file://")) {
    return path;
  }
  if (path.startsWith("/")) {
    return `file://${path}`;
  }
  return path;
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

export function getFileExtensionFromName(fileName: string | null | undefined): string {
  if (!fileName) {
    return "";
  }
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) {
    return "";
  }
  return fileName.slice(idx);
}

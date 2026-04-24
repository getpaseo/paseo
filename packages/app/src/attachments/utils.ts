import { generateMessageId } from "@/types/stream";
import { isAbsolutePath } from "@/utils/path";

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
  const match = /^data:([^,]*),([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Malformed data URL for attachment.");
  }
  const metadata = match[1] ?? "";
  const base64 = match[2]?.replace(/\s/g, "");
  const [mimeTypeRaw, ...parameters] = metadata.split(";").map((part) => part.trim());
  const isBase64 = parameters.some((part) => part.toLowerCase() === "base64");
  if (!isBase64) {
    throw new Error("Attachment data URL is not base64 encoded.");
  }
  if (!base64) {
    throw new Error("Attachment data URL is missing base64 payload.");
  }
  return {
    mimeType: normalizeMimeType(mimeTypeRaw),
    base64,
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function parseImageDataUrl(
  uri: string,
): { mimeType: string; base64: string; cacheKey: string } | null {
  if (!uri.trim().toLowerCase().startsWith("data:image/")) {
    return null;
  }

  try {
    const parsed = parseDataUrl(uri);
    if (!parsed.mimeType.toLowerCase().startsWith("image/")) {
      return null;
    }
    return {
      ...parsed,
      cacheKey: `data-image:${parsed.mimeType}:${parsed.base64.length}:${hashString(parsed.base64)}`,
    };
  } catch {
    return null;
  }
}

export function createImageSourceCacheKey(source: string): string {
  return parseImageDataUrl(source)?.cacheKey ?? source;
}

export function getFileNameFromPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const fileName = normalized.split("/").pop()?.trim();
  return fileName || null;
}

export function createPreviewAttachmentId(input: {
  base64: string;
  mimeType: string;
  path?: string | null;
}): string {
  const path = input.path?.trim() ?? "";
  const hash = hashString(`${input.mimeType}\0${path}\0${input.base64}`);
  return `preview_${input.base64.length}_${hash}`;
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

  if (!isAbsolutePath(path)) {
    return path;
  }

  if (path.startsWith("/")) {
    return `file://${path}`;
  }

  // UNC paths: \\server\share -> file://server/share
  if (path.startsWith("\\\\")) {
    return `file:${path.replace(/\\/g, "/")}`;
  }

  return `file:///${path.replace(/\\/g, "/")}`;
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

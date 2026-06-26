import type { DesktopHostBridge } from "@/desktop/host";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export interface DroppedFilePathPayload {
  imagePaths: string[];
  textPaths: string[];
  text: string | null;
}

function getLegacyFilePath(file: File): string | null {
  const path = Reflect.get(file, "path");
  return typeof path === "string" && path.length > 0 ? path : null;
}

function getFilePath(
  file: File,
  bridge: Pick<DesktopHostBridge, "webUtils"> | null,
): string | null {
  const getPathForFile = bridge?.webUtils?.getPathForFile;
  if (typeof getPathForFile === "function") {
    try {
      const path = getPathForFile(file);
      if (typeof path === "string" && path.length > 0) {
        return path;
      }
    } catch {
      return getLegacyFilePath(file);
    }
  }
  return getLegacyFilePath(file);
}

export function extractDroppedFilePaths(
  dataTransfer: DataTransfer | null,
  bridge: Pick<DesktopHostBridge, "webUtils"> | null,
): string[] {
  if (!dataTransfer) {
    return [];
  }

  const paths: string[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    const path = getFilePath(file, bridge);
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

function getFileExtension(path: string): string {
  const normalizedPath = path.split("#", 1)[0]?.split("?", 1)[0] ?? path;
  const extensionIndex = normalizedPath.lastIndexOf(".");
  if (extensionIndex < 0) {
    return "";
  }
  return normalizedPath.slice(extensionIndex).toLowerCase();
}

function isImagePath(path: string): boolean {
  return getFileExtension(path) in IMAGE_MIME_BY_EXTENSION;
}

export function getDroppedImageMimeType(path: string): string {
  return IMAGE_MIME_BY_EXTENSION[getFileExtension(path)] ?? "image/jpeg";
}

export function resolveDroppedFilePaths(paths: readonly string[]): DroppedFilePathPayload {
  const imagePaths: string[] = [];
  const textPaths: string[] = [];

  for (const path of paths) {
    if (isImagePath(path)) {
      imagePaths.push(path);
    } else {
      textPaths.push(path);
    }
  }

  return {
    imagePaths,
    textPaths,
    text: textPaths.length > 0 ? textPaths.join("\n") : null,
  };
}

export function appendDroppedFilePathText(input: {
  currentText: string;
  droppedText: string;
}): string {
  const { currentText, droppedText } = input;
  if (droppedText.length === 0) {
    return currentText;
  }
  if (currentText.length === 0) {
    return droppedText;
  }
  return /\s$/u.test(currentText)
    ? `${currentText}${droppedText}`
    : `${currentText}\n${droppedText}`;
}

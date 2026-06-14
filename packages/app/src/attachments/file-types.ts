const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
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
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript-jsx",
  ".jsx": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".xml": "text/xml",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const RASTER_IMAGE_MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const RASTER_IMAGE_MIME_TYPES = new Set(Object.values(RASTER_IMAGE_MIME_TYPE_BY_EXTENSION));

export const RASTER_IMAGE_FILE_EXTENSIONS = Object.keys(RASTER_IMAGE_MIME_TYPE_BY_EXTENSION).map(
  (extension) => extension.slice(1),
);

export function getFileExtension(path: string): string {
  const normalizedPath = path.split("#", 1)[0]?.split("?", 1)[0] ?? path;
  const extensionIndex = normalizedPath.lastIndexOf(".");
  if (extensionIndex < 0) {
    return "";
  }
  return normalizedPath.slice(extensionIndex).toLowerCase();
}

export function getFileTypeLabel(path: string): string | null {
  const extension = getFileExtension(path).slice(1);
  return extension ? extension.toUpperCase() : null;
}

export function getMimeTypeFromPath(path: string): string {
  return MIME_TYPE_BY_EXTENSION[getFileExtension(path)] ?? "application/octet-stream";
}

export function getRasterImageMimeTypeFromPath(path: string): string | null {
  return RASTER_IMAGE_MIME_TYPE_BY_EXTENSION[getFileExtension(path)] ?? null;
}

export function isRasterImagePath(path: string): boolean {
  return getRasterImageMimeTypeFromPath(path) !== null;
}

export function isRasterImageMimeType(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(normalized && RASTER_IMAGE_MIME_TYPES.has(normalized));
}

export function isRasterImageFile(file: Pick<File, "name" | "type">): boolean {
  if (isRasterImageMimeType(file.type)) {
    return true;
  }
  return file.type.trim().length === 0 && isRasterImagePath(file.name);
}

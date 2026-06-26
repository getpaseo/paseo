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
const GENERIC_FILE_MIME_TYPE = "application/octet-stream";

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
  return getRasterImageMimeTypeFromPath(path) ?? GENERIC_FILE_MIME_TYPE;
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

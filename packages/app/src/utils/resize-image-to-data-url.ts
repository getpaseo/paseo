/**
 * Client-side image resize → base64 data URL. Used for organization logos and
 * any other small avatar-style upload that ships inline in a JSON payload
 * rather than through blob storage. Web/Electron only — native mobile clients
 * should use a platform-specific picker.
 *
 * Square-crops by centering, downscales to `targetSize`, and encodes as WebP
 * (falls back to JPEG where WebP isn't available). Typical 256px output is
 * ~15–30KB, well under the auth-server's 256KB limit.
 */

const DEFAULT_TARGET_SIZE = 256;
const DEFAULT_QUALITY = 0.85;

export interface ResizeImageOptions {
  targetSize?: number;
  quality?: number;
  mimeType?: "image/webp" | "image/jpeg" | "image/png";
}

export async function resizeImageToDataUrl(
  file: File,
  options: ResizeImageOptions = {},
): Promise<string> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("resizeImageToDataUrl requires a DOM environment");
  }
  if (!file.type.startsWith("image/")) {
    throw new Error("Selected file is not an image");
  }

  const targetSize = options.targetSize ?? DEFAULT_TARGET_SIZE;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const mimeType = options.mimeType ?? "image/webp";

  const bitmap = await loadImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, targetSize, targetSize);

    const primary = canvas.toDataURL(mimeType, quality);
    if (primary.startsWith(`data:${mimeType}`)) return primary;
    // Browser ignored the requested mime type (Safari's older WebP gap, etc.).
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

async function loadImageBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Some older Electron builds reject SVG or animated images — fall back.
    }
  }
  return await new Promise<HTMLImageElement>((resolveImg, rejectImg) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolveImg(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rejectImg(new Error("Failed to decode image"));
    };
    img.src = url;
  });
}

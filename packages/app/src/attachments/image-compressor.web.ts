import {
  base64Bytes,
  type CompressImageInput,
  type EncodedAttachment,
} from "@/attachments/image-compression";

/** Longest edge we keep. Larger images are scaled down before re-encoding. */
const MAX_EDGE_PX = 1568;
const MAX_ATTEMPTS = 6;
const MIN_QUALITY = 0.4;
const MIN_SCALE = 0.3;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img), { once: true });
    img.addEventListener("error", () => reject(new Error("Failed to load image for compression")), {
      once: true,
    });
    img.src = url;
  });
}

/**
 * Web image compressor: draws the source into a canvas at decreasing scale and
 * JPEG quality until the encoded size drops under `targetBytes`. Returns the
 * smallest result produced (best effort) even if the target is not reached.
 */
export async function compressImage({
  url,
  targetBytes,
}: CompressImageInput): Promise<EncodedAttachment | null> {
  if (typeof document === "undefined") return null;

  const img = await loadImage(url);
  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;
  if (naturalWidth === 0 || naturalHeight === 0) return null;

  // Never upscale: start at 1 and only shrink if the image is larger than MAX_EDGE_PX.
  let scale = Math.min(1, MAX_EDGE_PX / Math.max(naturalWidth, naturalHeight));
  let best: EncodedAttachment | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return best;
    ctx.drawImage(img, 0, 0, width, height);

    const quality = Math.max(MIN_QUALITY, 0.82 - attempt * 0.12);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

    if (!best || base64.length < best.data.length) {
      best = { data: base64, mimeType: "image/jpeg" };
    }
    if (base64Bytes(base64) <= targetBytes) {
      return best;
    }

    if (scale <= MIN_SCALE && quality <= MIN_QUALITY) break;
    scale = Math.max(MIN_SCALE, scale * 0.8);
  }

  return best;
}

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  base64Bytes,
  type CompressImageInput,
  type EncodedAttachment,
} from "@/attachments/image-compression";

/** Longest edge we scale down to on the first resize pass. */
const MAX_EDGE_PX = 1568;
const MIN_EDGE_PX = 320;
const MAX_ATTEMPTS = 5;
const MIN_QUALITY = 0.4;

/**
 * Native image compressor (expo-image-manipulator). First pass re-encodes as
 * JPEG without resizing; subsequent passes shrink the longest edge and lower
 * quality until the encoded size drops under `targetBytes`. Returns the smallest
 * result produced (best effort) even if the target is not reached.
 */
export async function compressImage({
  url,
  targetBytes,
}: CompressImageInput): Promise<EncodedAttachment | null> {
  let best: EncodedAttachment | null = null;
  let width = MAX_EDGE_PX;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const quality = Math.max(MIN_QUALITY, 0.8 - attempt * 0.1);
    // First attempt: recompress only (no resize) to avoid upscaling small images.
    const context =
      attempt === 0
        ? ImageManipulator.manipulate(url)
        : ImageManipulator.manipulate(url).resize({ width });

    let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
    try {
      image = await context.renderAsync();
      const result = await image.saveAsync({
        format: SaveFormat.JPEG,
        compress: quality,
        base64: true,
      });
      const base64 = result.base64 ?? null;
      if (base64) {
        if (!best || base64.length < best.data.length) {
          best = { data: base64, mimeType: "image/jpeg" };
        }
        if (base64Bytes(base64) <= targetBytes) {
          return best;
        }
      }
    } catch (error) {
      console.warn("[attachments] Native compression attempt failed", { attempt, error });
    } finally {
      image?.release();
      context.release();
    }

    if (width <= MIN_EDGE_PX) break;
    width = Math.max(MIN_EDGE_PX, Math.round(width * 0.8));
  }

  return best;
}

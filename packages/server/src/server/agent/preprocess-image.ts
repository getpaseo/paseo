/**
 * Preprocess images before sending them to agent providers.
 *
 * The Claude Agent SDK resizes oversized images internally using sharp,
 * but sharp may not be available in the spawned CLI process. By resizing
 * here in the daemon (where sharp is available via the hoisted SDK
 * dependency), we avoid the "[System Error] Unable to resize image" failure.
 */
import type { Logger } from "pino";

const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 80;

interface ImageAttachment {
  data: string;
  mimeType: string;
}

type SharpModule = typeof import("sharp");

let sharpModule: SharpModule | null | undefined;

async function getSharp(): Promise<SharpModule | null> {
  if (sharpModule !== undefined) {
    return sharpModule;
  }
  try {
    sharpModule = (await import("sharp")).default;
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

/**
 * Resize an image if either dimension exceeds MAX_DIMENSION (2000px).
 * Returns the original attachment unchanged if no resize is needed or if
 * sharp is unavailable.
 */
export async function preprocessImage(
  image: ImageAttachment,
  logger?: Logger,
): Promise<ImageAttachment> {
  const sharp = await getSharp();
  if (!sharp) {
    logger?.debug("sharp unavailable, skipping image preprocessing");
    return image;
  }

  try {
    const inputBuffer = Buffer.from(image.data, "base64");
    const metadata = await sharp(inputBuffer).metadata();
    const { width, height } = metadata;

    if (!width || !height || (width <= MAX_DIMENSION && height <= MAX_DIMENSION)) {
      return image;
    }

    logger?.info(
      { originalWidth: width, originalHeight: height, maxDimension: MAX_DIMENSION },
      "Resizing oversized image before sending to agent",
    );

    const resized = await sharp(inputBuffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    return {
      data: resized.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (error) {
    logger?.warn({ error }, "Failed to preprocess image, sending original");
    return image;
  }
}

/**
 * Preprocess an array of image attachments, resizing any that exceed the
 * 2000x2000 pixel limit.
 */
export async function preprocessImages(
  images: Array<ImageAttachment> | undefined,
  logger?: Logger,
): Promise<Array<ImageAttachment> | undefined> {
  if (!images || images.length === 0) {
    return images;
  }
  return await Promise.all(images.map((img) => preprocessImage(img, logger)));
}

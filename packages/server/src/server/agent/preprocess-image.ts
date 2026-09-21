/**
 * Bound image attachments before they enter an agent's durable history.
 *
 * Providers cap image dimensions — Anthropic rejects anything over 2000px in a
 * many-image request. The rejection is not limited to the turn that carried the
 * image: once an oversized image is written into the conversation, every later
 * request replays it and fails the same way, and there is no in-app way to
 * repair the session (#4635).
 *
 * This is the daemon-side guard. It sits on the path every provider's image
 * blocks are assembled on, so it also covers callers the UI never sees —
 * `paseo agent send`, plugins, schedules, and direct WebSocket clients.
 *
 * Order matters as much as the strategy. Every check that can be answered from
 * the container header happens before the decoder is handed anything: a
 * decompression bomb declares gigapixels in a few kilobytes, so deciding
 * whether an attachment is safe by decoding it first is the wrong way round.
 * An attachment that is already inside the limits is never decoded at all.
 *
 * The clamp itself is the strategy pi and Claude Code both settled on: scale to
 * fit, then try PNG before any JPEG quality, and only shrink further when no
 * encoding makes the byte budget. PNG first matters because what reaches this
 * path is mostly UI and code screenshots — flat colour and small text, which
 * PNG keeps sharp and small and JPEG smears. A photo, which PNG cannot
 * compress, falls through to the JPEG ladder on its own.
 *
 * Decoding uses Photon, Rust compiled to WebAssembly. That is deliberate: the
 * daemon ships inside an Electron asar built for five platforms with
 * `npmRebuild: false`, and a codec that resolves to per-platform binaries is a
 * codec that silently resolves to nothing on the platforms CI did not build it
 * for. WASM either loads everywhere or nowhere, and it is 2MB. It is also the
 * decoder pi resizes with, so the same code path is already in daily use.
 *
 * What this module will not do is pretend. An attachment it cannot bound is
 * refused with a typed error rather than forwarded, because forwarding it is
 * the bug: the send fails either way, and only one of the two outcomes leaves
 * the conversation usable afterwards.
 */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { PhotonImage } from "@silvia-odwyer/photon-node";
import type { Logger } from "pino";
import { applyExifOrientation } from "./exif-orientation.js";
import { readImageDimensions, type ImageDimensions } from "./image-dimensions.js";

type Photon = typeof import("@silvia-odwyer/photon-node");

/** Anthropic's many-image ceiling. Also comfortably under OpenAI's 2000px long side. */
export const MAX_IMAGE_DIMENSION = 2000;
/**
 * Keeps the payload clear of the 5MB provider limit. Measured on the base64
 * text, which is what the limit is applied to and a third larger than the bytes.
 */
export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
/**
 * The largest source image this path will decode. Photon holds a decoded frame
 * as RGBA, so the ceiling is really a memory one: 50MP is ~200MB resident, and
 * it still clears a 48MP phone photo. Past it the decode is refused, which is
 * the only bound that holds against a file whose compressed size says nothing
 * about the allocation it asks for.
 */
export const MAX_SOURCE_PIXELS = 50_000_000;
/** The largest encoded attachment this path will base64-decode. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/**
 * More images than any provider accepts in one request (Anthropic's cap is
 * 100). Bounding the count bounds the work one prompt can ask the daemon for.
 */
export const MAX_IMAGES_PER_PROMPT = 100;
/** JPEG qualities tried, in order, once PNG has failed to make budget. */
const JPEG_QUALITIES = [80, 70, 55, 40];
/**
 * Encoding alone does not bound the payload: a high-entropy image can sit above
 * the budget at the bottom of the ladder. When it does, pixels have to go too.
 */
const SCALE_STEP = 0.75;
/** Never shrink past the point where the image stops being readable. */
const MIN_DIMENSION = 320;

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

/**
 * Per-call ceilings. Defaults are the strictest across the providers Paseo
 * talks to; a caller that knows its provider can widen or tighten them, which
 * is the seam a per-provider cap in `provider-manifest.ts` would use.
 */
export interface ImageLimits {
  maxDimension?: number;
  maxBytes?: number;
}

export interface ImageTooLargeErrorOptions {
  reason: string;
  mimeType: string;
  encodedBytes: number;
  dimensions: ImageDimensions | null;
}

/**
 * An attachment past a hard ceiling, refused before anything was allocated for
 * it. Shrinking it would mean doing the work the ceiling exists to prevent.
 */
export class ImageTooLargeError extends Error {
  readonly mimeType: string;
  readonly encodedBytes: number;
  readonly width: number | null;
  readonly height: number | null;

  constructor(options: ImageTooLargeErrorOptions) {
    super(`Image attachment rejected: ${options.reason}`);
    this.name = "ImageTooLargeError";
    this.mimeType = options.mimeType;
    this.encodedBytes = options.encodedBytes;
    this.width = options.dimensions?.width ?? null;
    this.height = options.dimensions?.height ?? null;
  }
}

export interface ImageDecodeErrorOptions {
  mimeType: string;
  dimensions: ImageDimensions;
  cause: unknown;
}

/**
 * The decoder failed on an attachment whose header parsed and whose dimensions
 * are over a ceiling. Distinct from `ImageTooLargeError` because the cause is
 * the codec rather than the input's size, and distinct from a bug because the
 * input came from a client.
 */
export class ImageDecodeError extends Error {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;

  constructor(options: ImageDecodeErrorOptions) {
    super(
      `Could not process a ${options.dimensions.width}x${options.dimensions.height} ${options.mimeType} attachment that is over the provider's limits`,
      { cause: options.cause },
    );
    this.name = "ImageDecodeError";
    this.mimeType = options.mimeType;
    this.width = options.dimensions.width;
    this.height = options.dimensions.height;
  }
}

export interface TooManyImagesErrorOptions {
  count: number;
  limit: number;
}

/** More attachments in one prompt than a provider would accept anyway. */
export class TooManyImagesError extends Error {
  readonly count: number;
  readonly limit: number;

  constructor(options: TooManyImagesErrorOptions) {
    super(`Prompt carries ${options.count} images, more than the limit of ${options.limit}`);
    this.name = "TooManyImagesError";
    this.count = options.count;
    this.limit = options.limit;
  }
}

/**
 * Formats whose bytes must survive untouched.
 *
 * GIF may be animated and re-encoding flattens it to a single frame; SVG is
 * vector and has no pixel dimensions to clamp. Neither can trip the pixel
 * ceiling in a way a raster downscale would fix, so both pass through.
 */
const PASSTHROUGH_MIME_TYPES = new Set(["image/gif", "image/svg+xml"]);

function isPassthrough(mimeType: string): boolean {
  return PASSTHROUGH_MIME_TYPES.has(mimeType.split(";")[0]!.trim().toLowerCase());
}

let photonLoad: Promise<Photon> | undefined;

/**
 * The WASM module is compiled on first use rather than at daemon start, and a
 * load failure propagates. A daemon that cannot clamp must not quietly forward
 * the image instead: that is exactly the state #4635 describes, and it would
 * reach the user as a conversation that has stopped working rather than as one
 * send that failed.
 */
function loadPhoton(): Promise<Photon> {
  photonLoad ??= import("@silvia-odwyer/photon-node").then(
    (mod) => (mod as { default?: Photon }).default ?? mod,
  );
  return photonLoad;
}

/** Base64 length of `bytes` once encoded, without encoding it. */
function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

interface Encoded {
  bytes: Uint8Array;
  mimeType: string;
}

/** PNG first, then the JPEG ladder; the first under budget wins. */
function encodeWithinBudget(image: PhotonImage, maxBytes: number): Encoded | null {
  const png = image.get_bytes();
  if (base64Length(png.byteLength) <= maxBytes) {
    return { bytes: png, mimeType: "image/png" };
  }
  for (const quality of JPEG_QUALITIES) {
    const jpeg = image.get_bytes_jpeg(quality);
    if (base64Length(jpeg.byteLength) <= maxBytes) {
      return { bytes: jpeg, mimeType: "image/jpeg" };
    }
  }
  return null;
}

function fitWithin(width: number, height: number, max: number): [number, number] {
  if (width <= max && height <= max) {
    return [width, height];
  }
  const scale = max / Math.max(width, height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

interface Clamped extends Encoded {
  width: number;
  height: number;
}

/**
 * Resize to the target, then keep taking a scale step until some encoding
 * makes budget or the readability floor is reached. Past the floor the
 * smallest JPEG produced is sent anyway: still bounded in pixels, which is the
 * ceiling that poisons a session.
 */
function clampToBudget(
  photon: Photon,
  decoded: PhotonImage,
  [targetWidth, targetHeight]: [number, number],
  maxBytes: number,
  logger?: Logger,
): Clamped {
  let smallest: Clamped | undefined;
  for (;;) {
    const scaled = photon.resize(
      decoded,
      targetWidth,
      targetHeight,
      photon.SamplingFilter.Lanczos3,
    );
    try {
      const width = scaled.get_width();
      const height = scaled.get_height();
      const encoded = encodeWithinBudget(scaled, maxBytes);
      if (encoded) {
        return { ...encoded, width, height };
      }
      const jpeg = scaled.get_bytes_jpeg(JPEG_QUALITIES.at(-1)!);
      if (!smallest || jpeg.byteLength < smallest.bytes.byteLength) {
        smallest = { bytes: jpeg, mimeType: "image/jpeg", width, height };
      }
    } finally {
      scaled.free();
    }
    const nextWidth = Math.floor(targetWidth * SCALE_STEP);
    const nextHeight = Math.floor(targetHeight * SCALE_STEP);
    if (Math.min(nextWidth, nextHeight) < MIN_DIMENSION) {
      break;
    }
    targetWidth = nextWidth;
    targetHeight = nextHeight;
  }
  // The loop always runs at least once and only leaves via `break` after
  // recording a candidate.
  const result = smallest!;
  logger?.warn(
    { bytes: result.bytes.byteLength, maxBytes },
    "Image stays over the byte budget at the minimum size, sending it anyway",
  );
  return result;
}

interface DecodeAndClampOptions {
  input: Buffer;
  dimensions: ImageDimensions;
  mimeType: string;
  maxDimension: number;
  maxBytes: number;
  logger?: Logger;
}

/**
 * The only part of this module that allocates a frame, reached only for an
 * attachment already established to be within the resource ceilings and over a
 * provider one. A codec failure here is wrapped rather than swallowed: the
 * caller gets an error naming the attachment instead of Photon's `unreachable`.
 */
function decodeAndClamp(photon: Photon, options: DecodeAndClampOptions): Clamped {
  let decoded: PhotonImage | undefined;
  try {
    const raw = photon.PhotonImage.new_from_byteslice(options.input);
    decoded = applyExifOrientation(photon, raw, options.input);
    if (decoded !== raw) {
      raw.free();
    }
    return clampToBudget(
      photon,
      decoded,
      fitWithin(decoded.get_width(), decoded.get_height(), options.maxDimension),
      options.maxBytes,
      options.logger,
    );
  } catch (error) {
    throw new ImageDecodeError({
      mimeType: options.mimeType,
      dimensions: options.dimensions,
      cause: error,
    });
  } finally {
    decoded?.free();
  }
}

export interface PreprocessImageOptions {
  image: ImageAttachment;
  logger?: Logger;
  limits?: ImageLimits;
}

/**
 * Clamp one attachment to the provider's pixel and byte ceilings.
 *
 * Returns the attachment unchanged when it is already within both, and when
 * its format must not be re-encoded. Throws `ImageTooLargeError` when the
 * attachment is past a resource ceiling and `ImageDecodeError` when the codec
 * cannot handle one that is over a provider ceiling.
 */
export async function preprocessImage(options: PreprocessImageOptions): Promise<ImageAttachment> {
  const { image, logger } = options;
  const maxDimension = options.limits?.maxDimension ?? MAX_IMAGE_DIMENSION;
  const maxBytes = options.limits?.maxBytes ?? MAX_IMAGE_BYTES;

  if (isPassthrough(image.mimeType)) {
    return image;
  }
  if (image.data.length > MAX_SOURCE_BYTES) {
    throw new ImageTooLargeError({
      reason: `its encoded payload is ${image.data.length} bytes, over the ${MAX_SOURCE_BYTES} byte ceiling`,
      mimeType: image.mimeType,
      encodedBytes: image.data.length,
      dimensions: null,
    });
  }

  const input = Buffer.from(image.data, "base64");
  const dimensions = readImageDimensions(input);

  if (!dimensions) {
    // An unreadable container is not a reason to decode and find out; that is
    // the allocation the ceilings exist to avoid. Within the provider's budget
    // it costs nothing to forward, and past it there is nothing safe to do.
    if (image.data.length <= maxBytes) {
      return image;
    }
    throw new ImageTooLargeError({
      reason: `its encoded payload is over the provider's byte budget and its container (${image.mimeType}) is not one this daemon can resize`,
      mimeType: image.mimeType,
      encodedBytes: image.data.length,
      dimensions: null,
    });
  }

  const { width, height } = dimensions;
  if (width * height > MAX_SOURCE_PIXELS) {
    throw new ImageTooLargeError({
      reason: `it declares ${width}x${height} pixels, over the ${MAX_SOURCE_PIXELS} pixel decode ceiling`,
      mimeType: image.mimeType,
      encodedBytes: image.data.length,
      dimensions,
    });
  }

  const oversized = width > maxDimension || height > maxDimension;
  const overBudget = image.data.length > maxBytes;
  // Anything already inside both ceilings leaves untouched and undecoded, which
  // is also what keeps a small PNG of flat UI from being transcoded for nothing.
  if (!oversized && !overBudget) {
    return image;
  }

  const photon = await loadPhoton();
  const clamped = decodeAndClamp(photon, {
    input,
    dimensions,
    mimeType: image.mimeType,
    maxDimension,
    maxBytes,
    logger,
  });

  logger?.info(
    {
      fromWidth: width,
      fromHeight: height,
      toWidth: clamped.width,
      toHeight: clamped.height,
      fromBytes: input.byteLength,
      toBytes: clamped.bytes.byteLength,
      toMimeType: clamped.mimeType,
    },
    "Clamped oversized image before dispatching to agent provider",
  );

  return { data: Buffer.from(clamped.bytes).toString("base64"), mimeType: clamped.mimeType };
}

export interface PreprocessImagesOptions {
  images: Array<ImageAttachment> | undefined;
  logger?: Logger;
  limits?: ImageLimits;
}

/**
 * Clamp every attachment in a prompt.
 *
 * The work is synchronous WASM, so the loop is sequential and yields between
 * attachments: one image at a time can hold the daemon's event loop, and a
 * 4864x2524 screenshot costs about half a second, once, at the moment the user
 * sends it. A prompt cannot queue an unbounded amount of that work, because
 * the count is capped and each image's decode is capped by `MAX_SOURCE_PIXELS`.
 */
export async function preprocessImages(
  options: PreprocessImagesOptions,
): Promise<Array<ImageAttachment> | undefined> {
  const { images } = options;
  if (!images || images.length === 0) {
    return images;
  }
  if (images.length > MAX_IMAGES_PER_PROMPT) {
    throw new TooManyImagesError({ count: images.length, limit: MAX_IMAGES_PER_PROMPT });
  }
  const processed: Array<ImageAttachment> = [];
  for (const image of images) {
    if (processed.length > 0) {
      await yieldToEventLoop();
    }
    processed.push(
      await preprocessImage({ image, logger: options.logger, limits: options.limits }),
    );
  }
  return processed;
}

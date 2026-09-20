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
 * The strategy is the one pi and Claude Code both settled on: leave anything
 * inside the limits byte-identical; otherwise scale to fit, then try PNG before
 * any JPEG quality, and only shrink further when no encoding makes the byte
 * budget. PNG first matters because what reaches this path is mostly UI and
 * code screenshots — flat colour and small text, which PNG keeps sharp and
 * small and JPEG smears. A photo, which PNG cannot compress, falls through to
 * the JPEG ladder on its own.
 *
 * Decoding uses Photon, Rust compiled to WebAssembly. That is deliberate: the
 * daemon ships inside an Electron asar built for five platforms with
 * `npmRebuild: false`, and a codec that resolves to per-platform binaries is a
 * codec that silently resolves to nothing on the platforms CI did not build it
 * for. WASM either loads everywhere or nowhere, and it is 2MB. It is also the
 * decoder pi resizes with, so the same code path is already in daily use.
 *
 * Every failure path returns the original attachment. A bounded image is better
 * than an unbounded one, but both are better than a dropped one.
 */
import type { PhotonImage } from "@silvia-odwyer/photon-node";
import type { Logger } from "pino";
import { applyExifOrientation } from "./exif-orientation.js";

type Photon = typeof import("@silvia-odwyer/photon-node");

/** Anthropic's many-image ceiling. Also comfortably under OpenAI's 2000px long side. */
export const MAX_IMAGE_DIMENSION = 2000;
/**
 * Keeps the payload clear of the 5MB provider limit. Measured on the base64
 * text, which is what the limit is applied to and a third larger than the bytes.
 */
export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
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

let photonLoad: Promise<Photon | null> | undefined;

/**
 * The WASM module is compiled on first use, not at daemon start, and a load
 * failure is remembered as "no decoder" rather than thrown: an image path that
 * cannot clamp still forwards the original, it does not take the daemon down.
 */
function loadPhoton(logger?: Logger): Promise<Photon | null> {
  photonLoad ??= import("@silvia-odwyer/photon-node").then(
    (mod) => (mod as { default?: Photon }).default ?? mod,
    (error: unknown) => {
      logger?.warn({ error }, "Image decoder failed to load, images will be forwarded as-is");
      return null;
    },
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

/**
 * Clamp one attachment to the provider's pixel and byte ceilings.
 *
 * Returns the attachment unchanged when it is already within budget, when its
 * format must not be re-encoded, or when anything at all goes wrong.
 */
export async function preprocessImage(
  image: ImageAttachment,
  logger?: Logger,
  limits?: ImageLimits,
): Promise<ImageAttachment> {
  const maxDimension = limits?.maxDimension ?? MAX_IMAGE_DIMENSION;
  const maxBytes = limits?.maxBytes ?? MAX_IMAGE_BYTES;

  if (isPassthrough(image.mimeType)) {
    return image;
  }

  const photon = await loadPhoton(logger);
  if (!photon) {
    return image;
  }

  let decoded: PhotonImage | undefined;
  try {
    const input = Buffer.from(image.data, "base64");
    const raw = photon.PhotonImage.new_from_byteslice(input);
    decoded = applyExifOrientation(photon, raw, input);
    if (decoded !== raw) {
      raw.free();
    }
    const width = decoded.get_width();
    const height = decoded.get_height();

    const oversized = width > maxDimension || height > maxDimension;
    const overBudget = image.data.length > maxBytes;
    // Anything already inside both ceilings leaves untouched, which is also what
    // keeps a small PNG of flat UI from being transcoded for nothing.
    if (!oversized && !overBudget) {
      return image;
    }

    const clamped = clampToBudget(
      photon,
      decoded,
      fitWithin(width, height, maxDimension),
      maxBytes,
      logger,
    );

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
  } catch (error) {
    logger?.warn({ error }, "Failed to preprocess image, forwarding the original");
    return image;
  } finally {
    decoded?.free();
  }
}

/**
 * Clamp every attachment in a prompt. The work itself is synchronous WASM, so
 * this is sequential on the event loop; a 4864x2524 screenshot costs about half
 * a second, once, at the moment the user sends it.
 */
export async function preprocessImages(
  images: Array<ImageAttachment> | undefined,
  logger?: Logger,
  limits?: ImageLimits,
): Promise<Array<ImageAttachment> | undefined> {
  if (!images || images.length === 0) {
    return images;
  }
  return await Promise.all(images.map((image) => preprocessImage(image, logger, limits)));
}

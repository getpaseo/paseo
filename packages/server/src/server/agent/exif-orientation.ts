/**
 * Apply a JPEG's or WebP's EXIF orientation to its decoded pixels.
 *
 * Photon decodes the pixels as stored and ignores the orientation tag. The
 * original bytes carry that tag, so a viewer shows a phone photo the right way
 * up; the re-encoded output we produce does not, so the pixels have to be
 * rotated before encoding or a downscaled photo comes out sideways.
 *
 * Adapted from pi (@earendil-works/pi-coding-agent, MIT), which resizes with
 * the same decoder and hit the same problem.
 */
import type { PhotonImage } from "@silvia-odwyer/photon-node";

type Photon = typeof import("@silvia-odwyer/photon-node");

const EXIF_ORIENTATION_TAG = 0x0112;

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
  // "Exif\0\0"
  return (
    bytes[offset] === 0x45 &&
    bytes[offset + 1] === 0x78 &&
    bytes[offset + 2] === 0x69 &&
    bytes[offset + 3] === 0x66 &&
    bytes[offset + 4] === 0 &&
    bytes[offset + 5] === 0
  );
}

function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
  if (tiffStart + 8 > bytes.length) return 1;
  const littleEndian = ((bytes[tiffStart]! << 8) | bytes[tiffStart + 1]!) === 0x4949;
  const read16 = (pos: number) =>
    littleEndian ? bytes[pos]! | (bytes[pos + 1]! << 8) : (bytes[pos]! << 8) | bytes[pos + 1]!;
  const read32 = (pos: number) =>
    littleEndian
      ? (bytes[pos]! |
          (bytes[pos + 1]! << 8) |
          (bytes[pos + 2]! << 16) |
          (bytes[pos + 3]! << 24)) >>>
        0
      : ((bytes[pos]! << 24) |
          (bytes[pos + 1]! << 16) |
          (bytes[pos + 2]! << 8) |
          bytes[pos + 3]!) >>>
        0;

  const ifdStart = tiffStart + read32(tiffStart + 4);
  if (ifdStart + 2 > bytes.length) return 1;
  const entryCount = read16(ifdStart);
  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifdStart + 2 + i * 12;
    if (entry + 12 > bytes.length) return 1;
    if (read16(entry) === EXIF_ORIENTATION_TAG) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function findJpegTiffOffset(bytes: Uint8Array): number {
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) return -1;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xe1) {
      const segmentStart = offset + 4;
      if (segmentStart + 6 > bytes.length) return -1;
      if (hasExifHeader(bytes, segmentStart)) return segmentStart + 6;
    }
    if (offset + 4 > bytes.length) return -1;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    offset += 2 + length;
  }
  return -1;
}

function findWebpTiffOffset(bytes: Uint8Array): number {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const chunkSize =
      bytes[offset + 4]! |
      (bytes[offset + 5]! << 8) |
      (bytes[offset + 6]! << 16) |
      (bytes[offset + 7]! << 24);
    const dataStart = offset + 8;
    if (chunkId === "EXIF") {
      if (dataStart + chunkSize > bytes.length) return -1;
      return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return -1;
}

/** 1 when the bytes carry no orientation, or one Photon cannot honour. */
export function readExifOrientation(bytes: Uint8Array): number {
  let tiffOffset = -1;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    tiffOffset = findJpegTiffOffset(bytes);
  } else if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    tiffOffset = findWebpTiffOffset(bytes);
  }
  return tiffOffset === -1 ? 1 : readOrientationFromTiff(bytes, tiffOffset);
}

/**
 * Photon's `rotate` is a general affine rotation and does not keep a 90° turn
 * pixel-exact, so the quarter turns are done by hand.
 */
function rotate90(
  photon: Photon,
  image: PhotonImage,
  dstIndex: (x: number, y: number, w: number, h: number) => number,
): PhotonImage {
  const w = image.get_width();
  const h = image.get_height();
  const src = image.get_raw_pixels();
  const dst = new Uint8Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = (y * w + x) * 4;
      const to = dstIndex(x, y, w, h) * 4;
      dst[to] = src[from]!;
      dst[to + 1] = src[from + 1]!;
      dst[to + 2] = src[from + 2]!;
      dst[to + 3] = src[from + 3]!;
    }
  }
  return new photon.PhotonImage(dst, h, w);
}

/**
 * Returns `image` itself when nothing needs doing, otherwise a new image. The
 * caller owns both and must free whichever it stops using.
 */
export function applyExifOrientation(
  photon: Photon,
  image: PhotonImage,
  originalBytes: Uint8Array,
): PhotonImage {
  switch (readExifOrientation(originalBytes)) {
    case 2:
      photon.fliph(image);
      return image;
    case 3:
      photon.fliph(image);
      photon.flipv(image);
      return image;
    case 4:
      photon.flipv(image);
      return image;
    case 5: {
      const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
      photon.fliph(rotated);
      return rotated;
    }
    case 6:
      return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
    case 7: {
      const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
      photon.fliph(rotated);
      return rotated;
    }
    case 8:
      return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
    default:
      return image;
  }
}

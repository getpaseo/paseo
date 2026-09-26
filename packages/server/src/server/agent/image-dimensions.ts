/**
 * Read an image's pixel dimensions out of its container header.
 *
 * Decoding an attachment to find out how big it is inverts the safety
 * property this path exists for: a few kilobytes of PNG can declare gigapixels,
 * and the allocation happens before any check can reject it. Every container
 * this daemon handles states its dimensions in the first few dozen bytes, so
 * the size check can happen before the decoder ever sees the payload.
 *
 * The parsers deliberately stop at the dimension fields. Anything malformed,
 * truncated, or simply unrecognised returns null, which the caller treats as
 * "not known to be safe" rather than "safe".
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function startsWith(bytes: Uint8Array, signature: Array<number>): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** IHDR is mandated to be the first chunk, so the dimensions sit at a fixed offset. */
function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) {
    return null;
  }
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

/** A start-of-frame marker carries the dimensions; every other segment is skipped by length. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) {
    return false;
  }
  // C4 is a Huffman table, C8 a JPEG extension, CC an arithmetic coding table.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1]!;
    // Fill bytes are legal padding between segments.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) {
      return null;
    }
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

/** Lossy WebP: dimensions live in the VP8 keyframe header, 14 bits each. */
function readVp8Dimensions(bytes: Uint8Array, dataStart: number): ImageDimensions | null {
  if (dataStart + 10 > bytes.length) {
    return null;
  }
  const syncOk =
    bytes[dataStart + 3] === 0x9d && bytes[dataStart + 4] === 0x01 && bytes[dataStart + 5] === 0x2a;
  if (!syncOk) {
    return null;
  }
  return {
    width: readUint16LE(bytes, dataStart + 6) & 0x3fff,
    height: readUint16LE(bytes, dataStart + 8) & 0x3fff,
  };
}

/** Lossless WebP: 14 bits of width-1 then 14 bits of height-1, after a one byte signature. */
function readVp8lDimensions(bytes: Uint8Array, dataStart: number): ImageDimensions | null {
  if (dataStart + 5 > bytes.length || bytes[dataStart] !== 0x2f) {
    return null;
  }
  const packed = readUint32LE(bytes, dataStart + 1);
  return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
}

/** Extended WebP: the canvas size, as two 24-bit values of size-1. */
function readVp8xDimensions(bytes: Uint8Array, dataStart: number): ImageDimensions | null {
  if (dataStart + 10 > bytes.length) {
    return null;
  }
  const width =
    (bytes[dataStart + 4]! | (bytes[dataStart + 5]! << 8) | (bytes[dataStart + 6]! << 16)) + 1;
  const height =
    (bytes[dataStart + 7]! | (bytes[dataStart + 8]! << 8) | (bytes[dataStart + 9]! << 16)) + 1;
  return { width, height };
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const chunkSize = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "VP8 ") {
      return readVp8Dimensions(bytes, dataStart);
    }
    if (chunkId === "VP8L") {
      return readVp8lDimensions(bytes, dataStart);
    }
    if (chunkId === "VP8X") {
      return readVp8xDimensions(bytes, dataStart);
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return null;
}

/** The logical screen descriptor, which bounds every frame in the file. */
function readGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) {
    return null;
  }
  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
}

function readBmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26) {
    return null;
  }
  const headerSize = readUint32LE(bytes, 14);
  // The 12 byte BITMAPCOREHEADER predates the 16 bit fields everything else uses.
  if (headerSize === 12) {
    return { width: readUint16LE(bytes, 18), height: readUint16LE(bytes, 20) };
  }
  // A negative height means the rows are stored top-down; the size is the same.
  return {
    width: Math.abs(readUint32LE(bytes, 18) | 0),
    height: Math.abs(readUint32LE(bytes, 22) | 0),
  };
}

/**
 * The dimensions declared by the attachment's container, or null when the
 * bytes are not a container this function can read. A null is not a verdict on
 * the image; it only means the size cannot be known without decoding.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  let dimensions: ImageDimensions | null = null;
  if (startsWith(bytes, PNG_SIGNATURE)) {
    dimensions = readPngDimensions(bytes);
  } else if (startsWith(bytes, [0xff, 0xd8])) {
    dimensions = readJpegDimensions(bytes);
  } else if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // RIFF
    bytes.length >= 12 &&
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    dimensions = readWebpDimensions(bytes);
  } else if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    dimensions = readGifDimensions(bytes);
  } else if (startsWith(bytes, [0x42, 0x4d])) {
    dimensions = readBmpDimensions(bytes);
  }
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }
  return dimensions;
}

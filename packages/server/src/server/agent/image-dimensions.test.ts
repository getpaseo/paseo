import { describe, expect, test } from "vitest";
import photon from "@silvia-odwyer/photon-node";
import { readImageDimensions } from "./image-dimensions.js";

function raster(width: number, height: number): photon.PhotonImage {
  return new photon.PhotonImage(new Uint8Array(width * height * 4).fill(0x80), width, height);
}

function png(width: number, height: number): Uint8Array {
  const image = raster(width, height);
  try {
    return image.get_bytes();
  } finally {
    image.free();
  }
}

function jpeg(width: number, height: number): Uint8Array {
  const image = raster(width, height);
  try {
    return image.get_bytes_jpeg(80);
  } finally {
    image.free();
  }
}

function riff(chunkId: string, payload: Buffer): Uint8Array {
  const chunk = Buffer.concat([
    Buffer.from(chunkId, "ascii"),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(payload.length);
      return size;
    })(),
    payload,
  ]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + chunk.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, chunk]);
}

function lossyWebp(width: number, height: number): Uint8Array {
  const payload = Buffer.alloc(10);
  payload.writeUInt8(0x9d, 3);
  payload.writeUInt8(0x01, 4);
  payload.writeUInt8(0x2a, 5);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff("VP8 ", payload);
}

function losslessWebp(width: number, height: number): Uint8Array {
  const payload = Buffer.alloc(5);
  payload.writeUInt8(0x2f, 0);
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return riff("VP8L", payload);
}

function extendedWebp(width: number, height: number): Uint8Array {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", payload);
}

function gif(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(54);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  // Negative means the rows are stored top-down, which does not change the size.
  bytes.writeInt32LE(-height, 22);
  return bytes;
}

describe("readImageDimensions", () => {
  const cases: Array<{ name: string; bytes: Uint8Array; width: number; height: number }> = [
    { name: "PNG", bytes: png(640, 480), width: 640, height: 480 },
    { name: "JPEG", bytes: jpeg(321, 123), width: 321, height: 123 },
    { name: "lossy WebP", bytes: lossyWebp(640, 480), width: 640, height: 480 },
    { name: "lossless WebP", bytes: losslessWebp(640, 480), width: 640, height: 480 },
    { name: "extended WebP", bytes: extendedWebp(4864, 2524), width: 4864, height: 2524 },
    { name: "GIF", bytes: gif(400, 300), width: 400, height: 300 },
    { name: "BMP with top-down rows", bytes: bmp(400, 300), width: 400, height: 300 },
  ];

  for (const { name, bytes, width, height } of cases) {
    test(`reads the dimensions of a ${name}`, () => {
      expect(readImageDimensions(bytes)).toEqual({ width, height });
    });
  }

  test("reads a JPEG whose dimensions sit behind an EXIF segment", () => {
    const source = jpeg(3000, 1500);
    const app1 = Buffer.alloc(4 + 2048);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(2048 + 2, 2);
    const withExif = Buffer.concat([
      Buffer.from(source.subarray(0, 2)),
      app1,
      Buffer.from(source.subarray(2)),
    ]);

    expect(readImageDimensions(withExif)).toEqual({ width: 3000, height: 1500 });
  });

  test("reads the header without needing the image body", () => {
    // The point of reading the header: 24 bytes are enough to decide whether
    // the rest is worth allocating.
    const header = png(4864, 2524).subarray(0, 24);

    expect(readImageDimensions(header)).toEqual({ width: 4864, height: 2524 });
  });

  const rejected: Array<{ name: string; bytes: Uint8Array }> = [
    { name: "a truncated PNG header", bytes: png(640, 480).subarray(0, 20) },
    { name: "a JPEG with no start-of-frame", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { name: "a RIFF container that is not WebP", bytes: Buffer.from("RIFF0000WAVEfmt ") },
    { name: "a WebP with no recognised chunk", bytes: riff("ICCP", Buffer.alloc(16)) },
    { name: "bytes that are not an image at all", bytes: Buffer.from("not an image") },
    { name: "an empty payload", bytes: new Uint8Array(0) },
  ];

  for (const { name, bytes } of rejected) {
    test(`returns null for ${name}`, () => {
      expect(readImageDimensions(bytes)).toBeNull();
    });
  }

  test("returns null rather than a zero-sized image", () => {
    expect(readImageDimensions(gif(0, 0))).toBeNull();
  });
});

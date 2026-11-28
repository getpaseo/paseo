/// <reference lib="dom" />
/**
 * Plaintext framing used inside the ciphertext once both peers negotiate
 * `deflatePayloads` in the E2EE handshake.
 *
 * Every application payload gets a one-byte kind header before encryption:
 *
 *   [0x00][bytes...]                          application binary
 *   [0x01][utf-8...]                          application text
 *   [0x02][u32le inflated length][deflate-raw] application text, compressed
 *
 * The header travels inside the authenticated plaintext, so the receiver reads
 * the payload kind from bytes the peer authenticated instead of the WebSocket
 * opcode. Each message is compressed on its own with no shared dictionary or
 * window, so one message's content cannot shift another message's size.
 */

import { deflateSync, inflateSync } from "fflate";

const KIND_BINARY = 0x00;
const KIND_TEXT = 0x01;
const KIND_DEFLATE_TEXT = 0x02;

export const PLAINTEXT_FRAME_HEADER_BYTES = 1;
const DEFLATE_LENGTH_BYTES = 4;

/**
 * Smallest UTF-8 text payload worth compressing. On timeline JSON, deflate
 * saves 80-200 bytes on 256-512 byte messages while each call still costs its
 * fixed table setup (about 15 us with a JIT, 130-300 us without one). Most
 * high-rate traffic (stream deltas, acks, keystrokes) is below this size and
 * stays uncompressed, which also keeps its length independent of compression.
 */
export const DEFLATE_TEXT_MIN_BYTES = 1024;

/**
 * Largest text a peer compresses, and the largest inflated size a receiver
 * accepts. Matches the relay's 32 MiB frame limit
 * (`MAX_RELAY_WEBSOCKET_MESSAGE_BYTES` in `@getpaseo/protocol`, which this
 * package does not depend on). Senders leave larger text uncompressed, so a
 * larger declared size is a protocol violation and fails the channel.
 */
export const MAX_INFLATED_TEXT_BYTES = 32 * 1024 * 1024;

/**
 * zlib's default. On a 160 KB timeline page level 1 costs about 35% less CPU
 * but produces about 10% more bytes; the daemon compresses most traffic and
 * runs with a JIT, so bytes win.
 */
const DEFLATE_LEVEL = 6;

/**
 * Text at least this large is probed before compressing. Phone uploads carry
 * base64 images inside JSON, which deflate shrinks by only about 23% while
 * nearly doubling encode time on Hermes; the binary frame alone already drops
 * the 33% base64 ciphertext overhead.
 */
export const COMPRESSIBILITY_PROBE_MIN_BYTES = 64 * 1024;
const COMPRESSIBILITY_PROBE_SAMPLES = 4;
const COMPRESSIBILITY_PROBE_SAMPLE_BYTES = 4 * 1024;
/**
 * On real timeline pages the best of four samples compressed to at most 0.57
 * whenever the whole page compressed to 0.61 or better; base64 image payloads
 * sampled at 0.76. One sample is not enough: a page whose middle is a base64
 * signature samples like an image.
 */
const COMPRESSIBILITY_PROBE_MAX_RATIO = 0.65;

function looksCompressible(utf8: Uint8Array): boolean {
  if (utf8.byteLength < COMPRESSIBILITY_PROBE_MIN_BYTES) return true;
  const span = utf8.byteLength - COMPRESSIBILITY_PROBE_SAMPLE_BYTES;
  for (let sample = 1; sample <= COMPRESSIBILITY_PROBE_SAMPLES; sample += 1) {
    const start = Math.floor((span * sample) / (COMPRESSIBILITY_PROBE_SAMPLES + 1));
    const bytes = utf8.subarray(start, start + COMPRESSIBILITY_PROBE_SAMPLE_BYTES);
    const compressed = deflateSync(bytes, { level: 1 });
    if (compressed.byteLength <= bytes.byteLength * COMPRESSIBILITY_PROBE_MAX_RATIO) return true;
  }
  return false;
}

export function encodePlaintextFrame(data: string | ArrayBuffer): ArrayBuffer {
  if (typeof data !== "string") {
    return withKind(KIND_BINARY, new Uint8Array(data));
  }
  const utf8 = new TextEncoder().encode(data);
  if (
    utf8.byteLength >= DEFLATE_TEXT_MIN_BYTES &&
    utf8.byteLength <= MAX_INFLATED_TEXT_BYTES &&
    looksCompressible(utf8)
  ) {
    const compressed = deflateSync(utf8, { level: DEFLATE_LEVEL });
    if (compressed.byteLength + DEFLATE_LENGTH_BYTES < utf8.byteLength) {
      const out = new Uint8Array(
        PLAINTEXT_FRAME_HEADER_BYTES + DEFLATE_LENGTH_BYTES + compressed.byteLength,
      );
      out[0] = KIND_DEFLATE_TEXT;
      new DataView(out.buffer).setUint32(PLAINTEXT_FRAME_HEADER_BYTES, utf8.byteLength, true);
      out.set(compressed, PLAINTEXT_FRAME_HEADER_BYTES + DEFLATE_LENGTH_BYTES);
      return out.buffer;
    }
  }
  return withKind(KIND_TEXT, utf8);
}

export function decodePlaintextFrame(frame: ArrayBuffer): string | ArrayBuffer {
  const bytes = new Uint8Array(frame);
  if (bytes.byteLength < PLAINTEXT_FRAME_HEADER_BYTES) {
    throw new Error("Framed plaintext is missing its kind header");
  }
  const body = bytes.subarray(PLAINTEXT_FRAME_HEADER_BYTES);
  switch (bytes[0]) {
    case KIND_BINARY:
      return frame.slice(PLAINTEXT_FRAME_HEADER_BYTES);
    case KIND_TEXT:
      return decodeUtf8(body);
    case KIND_DEFLATE_TEXT:
      return decodeUtf8(inflateText(body));
    default:
      throw new Error(`Unknown framed plaintext kind ${bytes[0]}`);
  }
}

function inflateText(body: Uint8Array): Uint8Array {
  if (body.byteLength < DEFLATE_LENGTH_BYTES) {
    throw new Error("Compressed plaintext is missing its inflated length");
  }
  const inflatedLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
    0,
    true,
  );
  if (inflatedLength > MAX_INFLATED_TEXT_BYTES) {
    throw new Error(
      `Compressed plaintext declares ${inflatedLength} bytes, above the ${MAX_INFLATED_TEXT_BYTES} byte limit`,
    );
  }
  // fflate never grows a caller-supplied buffer: output past its end is dropped or throws.
  // One spare byte detects a stream that inflates beyond the declared length.
  const inflated = inflateSync(body.subarray(DEFLATE_LENGTH_BYTES), {
    out: new Uint8Array(inflatedLength + 1),
  });
  if (inflated.byteLength !== inflatedLength) {
    throw new Error(
      `Compressed plaintext inflated to ${inflated.byteLength} bytes, expected ${inflatedLength}`,
    );
  }
  return inflated;
}

function withKind(kind: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(PLAINTEXT_FRAME_HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  out.set(payload, PLAINTEXT_FRAME_HEADER_BYTES);
  return out.buffer;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

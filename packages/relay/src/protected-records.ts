/**
 * Authenticated application-frame framing over Noise transport messages.
 *
 * One application frame becomes one wire record. Every Noise transport message
 * (chunk) carries, inside its authenticated plaintext, the frame kind, FIRST
 * and FINAL flags, and the total frame length, so a relay cannot merge two
 * records, split one across WebSocket messages, truncate a final chunk, or
 * re-chunk a frame without an authentication failure or a framing violation.
 * Transport AD is always empty, as in Noise §5.
 *
 *   chunk plaintext = kind(1) || flags(1) || totalLength(u32 BE) || data
 *   wire record     = for each chunk: ciphertextLength(u16 BE) || ciphertext
 */
import {
  CipherState,
  NoiseProtocolError,
  NOISE_MAX_MESSAGE_BYTES,
  NOISE_TAG_BYTES,
} from "./noise/index.js";

export type FrameKind = "text" | "binary";

const KIND_TEXT = 0x00;
const KIND_BINARY = 0x01;
const FLAG_FIRST = 0x01;
const FLAG_FINAL = 0x02;
const HEADER_BYTES = 6;
const LENGTH_PREFIX_BYTES = 2;
const EMPTY_AD = new Uint8Array(0);

/** Largest data payload a single chunk carries. */
export const MAX_CHUNK_DATA_BYTES = NOISE_MAX_MESSAGE_BYTES - NOISE_TAG_BYTES - HEADER_BYTES;
/** Largest application frame a record may carry; bounds allocation before decryption. */
export const MAX_FRAME_BYTES = 0xffff_ffff;
const CHUNK_OVERHEAD_BYTES = LENGTH_PREFIX_BYTES + HEADER_BYTES + NOISE_TAG_BYTES;

export function chunkCount(frameBytes: number): number {
  return Math.max(1, Math.ceil(frameBytes / MAX_CHUNK_DATA_BYTES));
}

/** Wire bytes a frame of `frameBytes` occupies once protected. */
export function protectedRecordByteLength(frameBytes: number): number {
  return frameBytes + chunkCount(frameBytes) * CHUNK_OVERHEAD_BYTES;
}

export function encodeProtectedRecord(
  kind: FrameKind,
  frame: Uint8Array,
  sender: CipherState,
): Uint8Array {
  if (frame.byteLength > MAX_FRAME_BYTES) throw new NoiseProtocolError("frame too large");
  const chunks = chunkCount(frame.byteLength);
  const out = new Uint8Array(protectedRecordByteLength(frame.byteLength));
  let offset = 0;
  for (let index = 0; index < chunks; index += 1) {
    const start = index * MAX_CHUNK_DATA_BYTES;
    const data = frame.subarray(start, Math.min(frame.byteLength, start + MAX_CHUNK_DATA_BYTES));
    const plaintext = new Uint8Array(HEADER_BYTES + data.byteLength);
    plaintext[0] = kind === "text" ? KIND_TEXT : KIND_BINARY;
    plaintext[1] = (index === 0 ? FLAG_FIRST : 0) | (index === chunks - 1 ? FLAG_FINAL : 0);
    writeU32(plaintext, 2, frame.byteLength);
    plaintext.set(data, HEADER_BYTES);
    const ciphertext = sender.encryptWithAd(EMPTY_AD, plaintext);
    writeU16(out, offset, ciphertext.byteLength);
    out.set(ciphertext, offset + LENGTH_PREFIX_BYTES);
    offset += LENGTH_PREFIX_BYTES + ciphertext.byteLength;
  }
  return out;
}

export interface DecodedFrame {
  kind: FrameKind;
  data: Uint8Array;
}

/**
 * Decodes one wire record. Chunks are authenticated in order and the receive
 * counter advances per authenticated chunk; any framing violation throws and
 * nothing partial is returned. The caller must close the channel on error.
 */
export function decodeProtectedRecord(record: Uint8Array, receiver: CipherState): DecodedFrame {
  let offset = 0;
  let assembly: RecordAssembly | null = null;
  while (offset < record.byteLength) {
    if (assembly !== null && assembly.index >= assembly.expectedChunks) {
      throw new NoiseProtocolError("unexpected chunk after final");
    }
    const { chunk, next } = readChunk(record, offset, receiver);
    offset = next;
    assembly =
      assembly === null
        ? startAssembly(chunk, record.byteLength)
        : continueAssembly(assembly, chunk);
  }
  if (assembly === null) throw new NoiseProtocolError("empty record");
  if (assembly.index !== assembly.expectedChunks || assembly.written !== assembly.totalLength) {
    throw new NoiseProtocolError("record incomplete");
  }
  return { kind: assembly.kind, data: assembly.frame };
}

interface Chunk {
  kind: FrameKind;
  isFirst: boolean;
  isFinal: boolean;
  totalLength: number;
  data: Uint8Array;
}

interface RecordAssembly {
  kind: FrameKind;
  totalLength: number;
  expectedChunks: number;
  frame: Uint8Array;
  written: number;
  index: number;
}

function readChunk(
  record: Uint8Array,
  offset: number,
  receiver: CipherState,
): { chunk: Chunk; next: number } {
  if (record.byteLength - offset < LENGTH_PREFIX_BYTES) {
    throw new NoiseProtocolError("record truncated");
  }
  const ciphertextLength = readU16(record, offset);
  const start = offset + LENGTH_PREFIX_BYTES;
  if (
    ciphertextLength < NOISE_TAG_BYTES + HEADER_BYTES ||
    ciphertextLength > NOISE_MAX_MESSAGE_BYTES
  ) {
    throw new NoiseProtocolError("invalid chunk length");
  }
  if (record.byteLength - start < ciphertextLength) {
    throw new NoiseProtocolError("record truncated");
  }
  const plaintext = receiver.decryptWithAd(
    EMPTY_AD,
    record.subarray(start, start + ciphertextLength),
  );
  const flags = plaintext[1];
  if ((flags & ~(FLAG_FIRST | FLAG_FINAL)) !== 0) {
    throw new NoiseProtocolError("reserved flag set");
  }
  return {
    chunk: {
      kind: decodeKind(plaintext[0]),
      isFirst: (flags & FLAG_FIRST) !== 0,
      isFinal: (flags & FLAG_FINAL) !== 0,
      totalLength: readU32(plaintext, 2),
      data: plaintext.subarray(HEADER_BYTES),
    },
    next: start + ciphertextLength,
  };
}

function startAssembly(chunk: Chunk, recordByteLength: number): RecordAssembly {
  if (!chunk.isFirst) throw new NoiseProtocolError("record does not start with FIRST");
  // The claimed frame length fixes the record's exact wire length. Check it
  // before allocating so a tiny authenticated header cannot demand gigabytes.
  if (protectedRecordByteLength(chunk.totalLength) !== recordByteLength) {
    throw new NoiseProtocolError("record length mismatch");
  }
  const assembly: RecordAssembly = {
    kind: chunk.kind,
    totalLength: chunk.totalLength,
    expectedChunks: chunkCount(chunk.totalLength),
    frame: new Uint8Array(chunk.totalLength),
    written: 0,
    index: 0,
  };
  return appendChunk(assembly, chunk);
}

function continueAssembly(assembly: RecordAssembly, chunk: Chunk): RecordAssembly {
  if (chunk.isFirst) throw new NoiseProtocolError("FIRST repeated inside record");
  if (chunk.kind !== assembly.kind) {
    throw new NoiseProtocolError("frame kind changed inside record");
  }
  if (chunk.totalLength !== assembly.totalLength) {
    throw new NoiseProtocolError("frame length changed inside record");
  }
  return appendChunk(assembly, chunk);
}

function appendChunk(assembly: RecordAssembly, chunk: Chunk): RecordAssembly {
  const isLastExpected = assembly.index === assembly.expectedChunks - 1;
  if (chunk.isFinal !== isLastExpected) throw new NoiseProtocolError("FINAL flag mismatch");
  const expectedData = isLastExpected
    ? assembly.totalLength - assembly.index * MAX_CHUNK_DATA_BYTES
    : MAX_CHUNK_DATA_BYTES;
  if (chunk.data.byteLength !== expectedData) throw new NoiseProtocolError("chunk size mismatch");
  assembly.frame.set(chunk.data, assembly.written);
  assembly.written += chunk.data.byteLength;
  assembly.index += 1;
  return assembly;
}

function decodeKind(byte: number): FrameKind {
  if (byte === KIND_TEXT) return "text";
  if (byte === KIND_BINARY) return "binary";
  throw new NoiseProtocolError("invalid frame kind");
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function readU16(source: Uint8Array, offset: number): number {
  return (source[offset] << 8) | source[offset + 1];
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readU32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset] << 24) >>> 0) +
    (source[offset + 1] << 16) +
    (source[offset + 2] << 8) +
    source[offset + 3]
  );
}

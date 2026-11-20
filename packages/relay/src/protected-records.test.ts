import { describe, expect, test } from "vitest";
import { CipherState, NoiseProtocolError } from "./noise/index.js";
import {
  decodeProtectedRecord,
  encodeProtectedRecord,
  MAX_CHUNK_DATA_BYTES,
  protectedRecordByteLength,
} from "./protected-records.js";

function pair(): { sender: CipherState; receiver: CipherState } {
  const key = new Uint8Array(32).map((_, i) => i + 1);
  const sender = new CipherState();
  const receiver = new CipherState();
  sender.initializeKey(key.slice());
  receiver.initializeKey(key.slice());
  return { sender, receiver };
}

function frameOf(length: number): Uint8Array {
  return new Uint8Array(length).map((_, i) => (i * 7 + 3) & 0xff);
}

const EMPTY = new Uint8Array(0);

/** Re-encrypts one chunk's plaintext under the next sender nonce. */
function reencrypt(sender: CipherState, plaintext: Uint8Array): Uint8Array {
  const ct = sender.encryptWithAd(EMPTY, plaintext);
  const out = new Uint8Array(2 + ct.byteLength);
  out[0] = ct.byteLength >>> 8;
  out[1] = ct.byteLength & 0xff;
  out.set(ct, 2);
  return out;
}

function chunkPlaintext(kind: number, flags: number, total: number, data: Uint8Array): Uint8Array {
  const pt = new Uint8Array(6 + data.byteLength);
  pt[0] = kind;
  pt[1] = flags;
  pt[2] = (total >>> 24) & 0xff;
  pt[3] = (total >>> 16) & 0xff;
  pt[4] = (total >>> 8) & 0xff;
  pt[5] = total & 0xff;
  pt.set(data, 6);
  return pt;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

describe("protected records", () => {
  test.each([
    ["empty text", "text", 0],
    ["empty binary", "binary", 0],
    ["small binary", "binary", 100],
    ["exactly one chunk", "text", MAX_CHUNK_DATA_BYTES],
    ["one byte over a chunk", "binary", MAX_CHUNK_DATA_BYTES + 1],
    ["exact multiple of chunks", "text", MAX_CHUNK_DATA_BYTES * 3],
    ["three and a bit chunks", "binary", MAX_CHUNK_DATA_BYTES * 3 + 17],
  ] as const)("round-trips %s", (_label, kind, length) => {
    const { sender, receiver } = pair();
    const frame = frameOf(length);
    const record = encodeProtectedRecord(kind, frame, sender);
    expect(record.byteLength).toBe(protectedRecordByteLength(length));
    const decoded = decodeProtectedRecord(record, receiver);
    expect(decoded.kind).toBe(kind);
    expect(Buffer.from(decoded.data).equals(Buffer.from(frame))).toBe(true);
    expect(receiver.nonce()).toBe(sender.nonce());
  });

  test("rejects two valid records concatenated into one message", () => {
    const { sender, receiver } = pair();
    const a = encodeProtectedRecord("text", frameOf(10), sender);
    const b = encodeProtectedRecord("text", frameOf(10), sender);
    expect(() => decodeProtectedRecord(concat(a, b), receiver)).toThrow(NoiseProtocolError);
  });

  test("rejects a multi-chunk record split across messages", () => {
    const { sender, receiver } = pair();
    const record = encodeProtectedRecord("binary", frameOf(MAX_CHUNK_DATA_BYTES + 5), sender);
    const firstChunkLength = 2 + ((record[0] << 8) | record[1]);
    const firstOnly = record.subarray(0, firstChunkLength);
    expect(() => decodeProtectedRecord(firstOnly, receiver)).toThrow(NoiseProtocolError);
  });

  test("rejects a record whose complete final chunk is removed", () => {
    const { sender, receiver } = pair();
    const record = encodeProtectedRecord("binary", frameOf(MAX_CHUNK_DATA_BYTES * 2), sender);
    const firstChunkLength = 2 + ((record[0] << 8) | record[1]);
    expect(() => decodeProtectedRecord(record.subarray(0, firstChunkLength), receiver)).toThrow(
      NoiseProtocolError,
    );
  });

  test("rejects zero chunks and trailing bytes", () => {
    const { sender, receiver } = pair();
    expect(() => decodeProtectedRecord(new Uint8Array(0), receiver)).toThrow(NoiseProtocolError);
    const record = encodeProtectedRecord("text", frameOf(3), sender);
    expect(() => decodeProtectedRecord(concat(record, new Uint8Array([0])), receiver)).toThrow(
      NoiseProtocolError,
    );
  });

  test("rejects an extra zero-byte FINAL chunk after an exact-multiple frame", () => {
    const { sender, receiver } = pair();
    const total = MAX_CHUNK_DATA_BYTES;
    const data = frameOf(total);
    const forged = concat(
      reencrypt(sender, chunkPlaintext(0x00, 0x01, total, data)),
      reencrypt(sender, chunkPlaintext(0x00, 0x02, total, EMPTY)),
    );
    expect(() => decodeProtectedRecord(forged, receiver)).toThrow(NoiseProtocolError);
  });

  test("rejects reserved flags, invalid kind, changed kind, and changed total length", () => {
    const cases: Array<[Uint8Array[]]> = [
      [[chunkPlaintext(0x00, 0x01 | 0x02 | 0x04, 1, new Uint8Array([1]))]],
      [[chunkPlaintext(0x02, 0x03, 1, new Uint8Array([1]))]],
      [
        [
          chunkPlaintext(0x00, 0x01, MAX_CHUNK_DATA_BYTES + 1, frameOf(MAX_CHUNK_DATA_BYTES)),
          chunkPlaintext(0x01, 0x02, MAX_CHUNK_DATA_BYTES + 1, new Uint8Array([1])),
        ],
      ],
      [
        [
          chunkPlaintext(0x00, 0x01, MAX_CHUNK_DATA_BYTES + 1, frameOf(MAX_CHUNK_DATA_BYTES)),
          chunkPlaintext(0x00, 0x02, MAX_CHUNK_DATA_BYTES + 2, new Uint8Array([1, 2])),
        ],
      ],
    ];
    for (const [plaintexts] of cases) {
      const { sender, receiver } = pair();
      const forged = concat(...plaintexts.map((pt) => reencrypt(sender, pt)));
      expect(() => decodeProtectedRecord(forged, receiver)).toThrow(NoiseProtocolError);
    }
  });

  test("rejects a tampered chunk without advancing past it, and later chunks never escape", () => {
    const { sender, receiver } = pair();
    const record = encodeProtectedRecord("binary", frameOf(MAX_CHUNK_DATA_BYTES + 5), sender);
    const tampered = record.slice();
    tampered[2 + 10] ^= 0x01;
    expect(() => decodeProtectedRecord(tampered, receiver)).toThrow(NoiseProtocolError);
    expect(receiver.nonce()).toBe(0n);
  });

  test("rejects a record whose header claims more bytes than it carries before allocating", () => {
    const { sender, receiver } = pair();
    const claimed = 64 * 1024 * 1024;
    const forged = reencrypt(sender, chunkPlaintext(0x01, 0x01, claimed, new Uint8Array([1])));
    const before = process.memoryUsage().arrayBuffers;
    expect(() => decodeProtectedRecord(forged, receiver)).toThrow("record length mismatch");
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
    // A relay that truncates a genuine large record gets the same answer.
    const { sender: s2, receiver: r2 } = pair();
    const genuine = encodeProtectedRecord("binary", frameOf(MAX_CHUNK_DATA_BYTES * 2 + 1), s2);
    const firstChunkOnly = genuine.subarray(0, 2 + 6 + MAX_CHUNK_DATA_BYTES + 16);
    expect(() => decodeProtectedRecord(firstChunkOnly, r2)).toThrow("record length mismatch");
    expect(r2.nonce()).toBe(1n);
  });

  test("a record delivered twice fails the second time", () => {
    const { sender, receiver } = pair();
    const record = encodeProtectedRecord("text", frameOf(20), sender);
    decodeProtectedRecord(record, receiver);
    expect(() => decodeProtectedRecord(record, receiver)).toThrow(NoiseProtocolError);
  });
});

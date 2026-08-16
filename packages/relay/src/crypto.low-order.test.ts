import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";

import {
  CANONICAL_LOW_ORDER_POINTS,
  InvalidPeerKeyError,
  deriveSharedKey,
  generateKeyPair,
} from "./index.js";

/**
 * Negative tests for peer-key validation.
 *
 * `crypto.test.ts` covers the happy path. Nothing there feeds a hostile key,
 * which is exactly how the low-order-point flaw survived: every positive test
 * passed while an attacker could force a predictable shared key.
 */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The same table `crypto.ts` rejects, repeated here on purpose.
 *
 * Duplicating it means the suite fails if either copy drifts, and the
 * self-check below proves these are genuinely low order rather than trusting
 * that they were transcribed correctly. A blacklist with a mistyped constant
 * would otherwise pass every test while protecting nothing.
 */
// The shipped table, not a copy of it. Transcribing it here meant the suite
// could exercise a different blacklist from the one that ships, the moment
// either drifted.
const CANONICAL_LOW_ORDER_POINT_HEX = CANONICAL_LOW_ORDER_POINTS;

/** Each canonical point plus its high-bit-set encoding, which X25519 treats identically. */
const LOW_ORDER_POINT_HEX = CANONICAL_LOW_ORDER_POINT_HEX.flatMap((hex) => {
  const withHighBit =
    hex.slice(0, 62) +
    ((Number.parseInt(hex.slice(62), 16) | 0x80) >>> 0).toString(16).padStart(2, "0");
  return [hex, withHighBit];
});

describe("low-order point rejection", () => {
  // This is the load-bearing test. If a constant above is wrong, the point is
  // not actually low order, the assertion fails, and we learn the blacklist is
  // broken -- instead of shipping a check that silently matches nothing.
  it.each(LOW_ORDER_POINT_HEX)("%s is genuinely a low-order point", (hex) => {
    const point = hexToBytes(hex);
    const secret = generateKeyPair().secretKey;

    const raw = nacl.scalarMult(secret, point);

    expect(bytesToHex(raw)).toBe("00".repeat(32));
  });

  it.each(LOW_ORDER_POINT_HEX)("deriveSharedKey rejects %s", (hex) => {
    const secret = generateKeyPair().secretKey;

    expect(() => deriveSharedKey(secret, hexToBytes(hex))).toThrow(InvalidPeerKeyError);
  });

  it("rejects the all-zero peer key", () => {
    const secret = generateKeyPair().secretKey;

    expect(() => deriveSharedKey(secret, new Uint8Array(32))).toThrow(InvalidPeerKeyError);
  });

  // The attack: without validation both sides derive a key the attacker can
  // compute for ANY secret key, because the X25519 output is a constant.
  it("would otherwise yield an attacker-predictable key for any secret", () => {
    const zeroPoint = new Uint8Array(32);

    const rawA = nacl.scalarMult(generateKeyPair().secretKey, zeroPoint);
    const rawB = nacl.scalarMult(generateKeyPair().secretKey, zeroPoint);

    // Two unrelated secrets, identical output -- this is why it must be rejected.
    expect(bytesToHex(rawA)).toBe(bytesToHex(rawB));
    expect(bytesToHex(rawA)).toBe("00".repeat(32));
  });

  it("still accepts honest keys", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const ab = deriveSharedKey(alice.secretKey, bob.publicKey);
    const ba = deriveSharedKey(bob.secretKey, alice.publicKey);

    expect(bytesToHex(ab)).toBe(bytesToHex(ba));
    expect(bytesToHex(ab)).not.toBe("00".repeat(32));
  });
});

describe("validation and derivation see the same bytes", () => {
  // The property, not one implementation's read count: every index of the
  // caller's array must be read exactly once. An earlier version of this test
  // only switched the bytes after 480 reads, so an unsafe implementation making
  // 64 reads passed it while still validating one value and deriving another.
  it("reads each index of the peer key exactly once", () => {
    const basepoint = new Uint8Array(32);
    basepoint[0] = 9;
    const zero = new Uint8Array(32);
    const reads: number[] = Array.from({ length: 32 }, () => 0);

    const onceOnly = new Proxy(basepoint, {
      get(target, prop) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const i = Number(prop);
          reads[i] = (reads[i] ?? 0) + 1;
          // Honest the first time, hostile every time after. Any implementation
          // that reads an index twice derives from the all-zero point.
          return (reads[i] as number) === 1 ? basepoint[i] : zero[i];
        }
        return Reflect.get(target, prop);
      },
    }) as Uint8Array;

    const secret = generateKeyPair().secretKey;
    const derived = deriveSharedKey(secret, onceOnly);

    expect(reads.every((n) => n === 1)).toBe(true);
    expect(bytesToHex(derived)).toBe(bytesToHex(deriveSharedKey(secret, basepoint)));
    expect(bytesToHex(derived)).not.toBe(
      "351f86faa3b988468a850122b65b0acece9c4826806aeee63de9c0da2bd7f91e",
    );
  });

  it("rejects key material that is not a full sequence of bytes", () => {
    // A one-byte array claiming to be 32 used to be zero-padded into the very
    // point the blacklist rejects.
    const short = new Uint8Array(1);
    short[0] = 9;
    Object.defineProperty(short, "byteLength", { value: 32 });

    expect(() => deriveSharedKey(generateKeyPair().secretKey, short)).toThrow(InvalidPeerKeyError);
  });
});

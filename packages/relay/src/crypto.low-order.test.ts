import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";

import { InvalidPeerKeyError, deriveSharedKey, generateKeyPair } from "./index.js";

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
const CANONICAL_LOW_ORDER_POINT_HEX = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
] as const;

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
  // Checking one value and deriving from another is the classic way a
  // validation gets stepped around: a caller can pass an object whose indexed
  // reads change between the check and the use. deriveSharedKey is exported,
  // so "no caller in this repo does that" is not the bar.
  it("rejects a peer key whose bytes change after validation", () => {
    const basepoint = new Uint8Array(32);
    basepoint[0] = 9;
    const zero = new Uint8Array(32);

    let reads = 0;
    const shifting = new Proxy(basepoint, {
      get(target, prop) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          reads += 1;
          // Honest while inspected, all-zero once the checks are done.
          return reads <= 480 ? basepoint[Number(prop)] : zero[Number(prop)];
        }
        return Reflect.get(target, prop);
      },
    }) as Uint8Array;

    const secret = generateKeyPair().secretKey;
    const derived = deriveSharedKey(secret, shifting);

    // The all-zero point yields this key for every secret; deriving it would
    // mean the peer knows the session key.
    expect(bytesToHex(derived)).not.toBe(
      "351f86faa3b988468a850122b65b0acece9c4826806aeee63de9c0da2bd7f91e",
    );
    expect(bytesToHex(derived)).toBe(bytesToHex(deriveSharedKey(secret, basepoint)));
  });
});

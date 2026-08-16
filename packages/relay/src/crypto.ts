/// <reference lib="dom" />
/**
 * E2EE crypto primitives using NaCl (tweetnacl).
 *
 * - Key exchange: Curve25519 (nacl.box.before)
 * - Encryption: XSalsa20-Poly1305 (nacl.box.after / open.after)
 *
 * Bundle format (binary):
 *   [nonce (24 bytes)] [ciphertext...]
 *
 * The encrypted channel chooses the WebSocket representation. Crypto remains
 * byte-oriented so frame kind is never inferred from plaintext contents.
 */

import nacl from "tweetnacl";
import { fromByteArray, toByteArray } from "base64-js";

export interface KeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes
}

export type SharedKey = Uint8Array; // 32 bytes (box.before)

const NONCE_LENGTH = nacl.box.nonceLength; // 24

let prngReady = false;

interface GlobalWithCrypto {
  crypto?: Crypto;
}

function getGlobalCrypto(): Crypto | undefined {
  const g = globalThis as GlobalWithCrypto;
  return g.crypto;
}

function ensurePrng(): void {
  if (prngReady) return;

  try {
    nacl.randomBytes(1);
    prngReady = true;
    return;
  } catch {
    // fallthrough
  }

  const cryptoObj = getGlobalCrypto();
  if (cryptoObj?.getRandomValues) {
    nacl.setPRNG((x, n) => {
      const buf = new Uint8Array(n);
      cryptoObj.getRandomValues(buf);
      x.set(buf, 0);
    });
    prngReady = true;
    return;
  }

  throw new Error("No secure PRNG available for tweetnacl (missing crypto.getRandomValues)");
}

function encodeBase64(bytes: Uint8Array): string {
  return fromByteArray(bytes);
}

function decodeBase64(base64: string): Uint8Array {
  return toByteArray(base64);
}

function toUint8(data: string | ArrayBuffer): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

export function generateKeyPair(): KeyPair {
  ensurePrng();
  const { publicKey, secretKey } = nacl.box.keyPair();
  return { publicKey, secretKey };
}

export function exportPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length (expected ${nacl.box.publicKeyLength})`);
  }
  return encodeBase64(publicKey);
}

export function importPublicKey(base64: string): Uint8Array {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length (expected ${nacl.box.publicKeyLength})`);
  }
  return bytes;
}

export function exportSecretKey(secretKey: Uint8Array): string {
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  return encodeBase64(secretKey);
}

export function importSecretKey(base64: string): Uint8Array {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  return bytes;
}

/**
 * Raised when a peer-supplied public key is unusable for key agreement.
 *
 * Distinct from a generic Error so callers can close the channel uniformly
 * without leaking *which* validation fired, and so tests can assert on the
 * specific failure rather than on any throw.
 */
export class InvalidPeerKeyError extends Error {
  constructor(message = "Invalid peer public key") {
    super(message);
    this.name = "InvalidPeerKeyError";
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Curve25519 points of small order, little-endian u-coordinates.
 *
 * A peer supplying one of these forces the X25519 output to the all-zero
 * value, so both sides derive a shared key the attacker knows without ever
 * possessing the corresponding secret. RFC 7748 section 6 prescribes
 * rejecting the all-zero result for exactly this reason.
 *
 * The all-zero output check in `deriveSharedKey` is on its own sufficient —
 * with clamped scalars every low-order input produces it. This table is
 * defense in depth plus an early reject, so we never run the scalar
 * multiplication on a known-bad point. `crypto.negative.test.ts` proves each
 * entry really is low order, so a mistyped constant fails the suite instead
 * of silently weakening the check.
 */
const CANONICAL_LOW_ORDER_POINTS: readonly string[] = [
  // 0 and 1
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  // the two points of order 8
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  // p-1 (order 2), p (= 0), p+1 (= 1)
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

/**
 * X25519 ignores the top bit of the final byte, so each canonical point above
 * has a second encoding with that bit set which is equally dangerous. Derive
 * those rather than transcribing another seven constants -- every hand-copied
 * value is a chance to write one that matches nothing.
 */
const LOW_ORDER_POINTS: readonly Uint8Array[] = Object.freeze(
  CANONICAL_LOW_ORDER_POINTS.flatMap((hex) => {
    const canonical = hexToBytes(hex);
    const highBitSet = Uint8Array.from(canonical);
    highBitSet[31] = (highBitSet[31] as number) | 0x80;
    return [canonical, highBitSet];
  }),
);

/**
 * True when every byte is zero.
 *
 * Accumulates over the whole buffer with no early exit because the input is
 * derived from a secret key. JavaScript cannot guarantee constant time (JIT,
 * GC), but not short-circuiting removes the obvious signal.
 */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i] as number;
  return acc === 0;
}

/**
 * True when `publicKey` is one of the known small-order points.
 *
 * Both operands are public, so this needs no timing guarantee; it still
 * avoids an early exit to keep the shape identical to `isAllZero`.
 */
function isLowOrderPoint(publicKey: Uint8Array): boolean {
  let matched = 0;
  for (const candidate of LOW_ORDER_POINTS) {
    let diff = 0;
    for (let i = 0; i < candidate.length; i++) {
      diff |= (publicKey[i] as number) ^ (candidate[i] as number);
    }
    matched |= diff === 0 ? 1 : 0;
  }
  return matched === 1;
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): SharedKey {
  if (ourSecretKey.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  if (peerPublicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid peer public key length (expected ${nacl.box.publicKeyLength})`);
  }
  if (isLowOrderPoint(peerPublicKey)) {
    throw new InvalidPeerKeyError("Peer public key is a low-order Curve25519 point");
  }

  // `box.before` hashes the raw X25519 output through HSalsa20, so inspecting
  // its result cannot detect the all-zero case. Check the raw scalar
  // multiplication directly.
  if (isAllZero(nacl.scalarMult(ourSecretKey, peerPublicKey))) {
    throw new InvalidPeerKeyError("X25519 key agreement produced an all-zero shared secret");
  }

  return nacl.box.before(peerPublicKey, ourSecretKey);
}

/**
 * Encrypts data and returns the binary bundle:
 *   [nonce (24)] [ciphertext...]
 */
export function encrypt(sharedKey: SharedKey, data: string | ArrayBuffer): ArrayBuffer {
  ensurePrng();
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const plaintext = toUint8(data);
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey);
  const out = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.byteLength);
  return toArrayBuffer(out);
}

export function decrypt(sharedKey: SharedKey, data: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(data);
  if (bytes.byteLength < NONCE_LENGTH) {
    throw new Error("Ciphertext bundle too short");
  }

  const nonce = bytes.slice(0, NONCE_LENGTH);
  const ciphertext = bytes.slice(NONCE_LENGTH);
  const opened = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!opened) {
    throw new Error("Decryption failed");
  }

  return toArrayBuffer(opened);
}

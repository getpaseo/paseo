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
const ZERO_X25519_SHARED_RESULT = new Uint8Array(nacl.box.sharedKeyLength);

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

function decodePublicKeyBase64(base64: string): Uint8Array {
  if (
    typeof base64 !== "string" ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error("Invalid public key encoding");
  }

  const bytes = decodeBase64(base64);
  if (encodeBase64(bytes) !== base64) {
    throw new Error("Invalid public key encoding");
  }
  return bytes;
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
  const bytes = decodePublicKeyBase64(base64);
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

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): SharedKey {
  if (ourSecretKey.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  if (peerPublicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid peer public key length (expected ${nacl.box.publicKeyLength})`);
  }

  const rawSharedResult = nacl.scalarMult(ourSecretKey, peerPublicKey);
  const isAllZero = nacl.verify(rawSharedResult, ZERO_X25519_SHARED_RESULT);
  rawSharedResult.fill(0);
  if (isAllZero) {
    throw new Error("Invalid peer public key");
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

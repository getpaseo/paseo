/// <reference lib="dom" />
/**
 * E2EE crypto primitives using WebCrypto API.
 *
 * - ECDH P-256 for key exchange
 * - HKDF for key derivation
 * - AES-256-GCM for authenticated encryption
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";

const ECDH_ALGORITHM = { name: "ECDH", namedCurve: "P-256" };
const AES_ALGORITHM = { name: "AES-GCM", length: 256 };
const IV_LENGTH = 12;

/**
 * Generate an ECDH P-256 keypair for key exchange.
 */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_ALGORITHM, true, ["deriveBits"]);
}

/**
 * Export a public key to base64 string (for transmission).
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64(raw);
}

/**
 * Import a public key from base64 string.
 */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToArrayBuffer(base64);
  return crypto.subtle.importKey("raw", raw, ECDH_ALGORITHM, true, []);
}

/**
 * Derive a shared AES-256-GCM key from ECDH key exchange.
 *
 * Uses HKDF with SHA-256 to derive the final key.
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey
): Promise<CryptoKey> {
  // Perform ECDH to get shared secret bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256
  );

  // Import shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );

  // Derive AES-256-GCM key using HKDF
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("paseo-e2ee-v1"),
    },
    hkdfKey,
    AES_ALGORITHM,
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt data with AES-256-GCM.
 *
 * Returns: [IV (12 bytes)][ciphertext + auth tag]
 */
export async function encrypt(
  key: CryptoKey,
  data: string | ArrayBuffer
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext =
    typeof data === "string" ? new TextEncoder().encode(data) : data;

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  // Prepend IV to ciphertext
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);

  return result.buffer;
}

/**
 * Decrypt data with AES-256-GCM.
 *
 * Input format: [IV (12 bytes)][ciphertext + auth tag]
 * Returns string if original was string, ArrayBuffer if binary.
 */
export async function decrypt(
  key: CryptoKey,
  data: ArrayBuffer
): Promise<string | ArrayBuffer> {
  const dataArray = new Uint8Array(data);
  const iv = dataArray.slice(0, IV_LENGTH);
  const ciphertext = dataArray.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  // Try to decode as UTF-8 string, fall back to ArrayBuffer
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return plaintext;
  }
}

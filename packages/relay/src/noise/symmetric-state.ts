import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { CipherState } from "./cipher-state.js";

/** Noise spec §5.2 SymmetricState for SHA256 (HASHLEN 32). */

const HASHLEN = 32;
const EMPTY = new Uint8Array(0);

export class SymmetricState {
  readonly cipher = new CipherState();
  private ck: Uint8Array;
  private h: Uint8Array;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.byteLength <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h.slice();
    this.cipher.initializeKey(null);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.cipher.initializeKey(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    this.ck.fill(0);
    this.cipher.clear();
    return [c1, c2];
  }
}

/** Noise spec §4.3 HKDF with two outputs: HMAC chain with 0x01 and 0x02 info bytes. */
function hkdf2(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const output1 = hmac(sha256, tempKey, new Uint8Array([0x01]));
  const output2 = hmac(sha256, tempKey, concat(output1, new Uint8Array([0x02])));
  tempKey.fill(0);
  return [output1, output2];
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

import { fromByteArray, toByteArray } from "base64-js";

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return fromByteArray(new Uint8Array(buffer));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = (() => {
    const trimmed = base64.trim();
    const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (standard.length % 4)) % 4;
    return standard + "=".repeat(padLen);
  })();

  const bytes = toByteArray(normalized);
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

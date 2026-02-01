import { fromByteArray, toByteArray } from "base64-js";

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return fromByteArray(new Uint8Array(buffer));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = toByteArray(base64);
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

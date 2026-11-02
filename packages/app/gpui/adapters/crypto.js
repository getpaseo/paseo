import Desktop from "../desktop/src/NativePaseoDesktop";
export function getRandomValues(array) {
  if (
    !ArrayBuffer.isView(array) ||
    array instanceof DataView ||
    array instanceof Float32Array ||
    array instanceof Float64Array
  ) {
    throw new TypeError("getRandomValues requires an integer typed array");
  }
  if (array.byteLength > 65536) throw new RangeError("Random request exceeds 65536 bytes");
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
    Desktop.randomBytes(array.byteLength),
  );
  return array;
}
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
export const CryptoDigestAlgorithm = { SHA256: "SHA-256" };
export async function digestStringAsync(algorithm, text) {
  if (algorithm !== "SHA-256") throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  return Desktop.sha256(text);
}

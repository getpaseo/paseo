import { Buffer } from "buffer";

declare global {
  interface Crypto {
    randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  }
}

export interface CryptoPolyfillTarget {
  TextEncoder?: typeof TextEncoder;
  TextDecoder?: typeof TextDecoder;
  crypto?: Crypto;
}

type RandomUUID = `${string}-${string}-${string}-${string}-${string}`;
type FillRandomValues = <T extends ArrayBufferView | null>(array: T) => T;

export interface CryptoPolyfillSources {
  expoGetRandomValues: FillRandomValues;
}

function createUuidV4(fillRandomValues: FillRandomValues): RandomUUID {
  const bytes = fillRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}` as RandomUUID;
}

export function installCryptoPolyfills(
  target: CryptoPolyfillTarget,
  sources: CryptoPolyfillSources,
): void {
  const nativeGetRandomValues =
    typeof target.crypto?.getRandomValues === "function"
      ? target.crypto.getRandomValues.bind(target.crypto)
      : null;

  // Ensure TextEncoder/TextDecoder exist for shared E2EE code (tweetnacl + relay transport).
  // Hermes may not provide them in all configurations.
  if (typeof target.TextEncoder !== "function") {
    class BufferTextEncoder {
      encode(input = ""): Uint8Array {
        return Uint8Array.from(Buffer.from(input, "utf8"));
      }
    }
    target.TextEncoder = BufferTextEncoder as unknown as typeof TextEncoder;
  }

  if (typeof target.TextDecoder !== "function") {
    class BufferTextDecoder {
      decode(input?: ArrayBuffer | ArrayBufferView): string {
        if (input == null) return "";
        if (input instanceof ArrayBuffer) {
          return Buffer.from(input).toString("utf8");
        }
        if (ArrayBuffer.isView(input)) {
          return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
        }
        return Buffer.from(String(input), "utf8").toString("utf8");
      }
    }
    target.TextDecoder = BufferTextDecoder as unknown as typeof TextDecoder;
  }

  if (!target.crypto) {
    target.crypto = {} as Crypto;
  }

  const fillRandomValues: FillRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array;
    if (nativeGetRandomValues) {
      return nativeGetRandomValues(array as unknown as ArrayBufferView<ArrayBuffer>) as T;
    }
    return sources.expoGetRandomValues(array);
  };

  if (typeof target.crypto.randomUUID !== "function") {
    target.crypto.randomUUID = () => createUuidV4(fillRandomValues);
  }

  if (typeof target.crypto.getRandomValues !== "function") {
    target.crypto.getRandomValues = fillRandomValues;
  }
}

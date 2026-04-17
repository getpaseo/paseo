import * as ExpoCrypto from "expo-crypto";
import { Buffer } from "buffer";

declare global {
  interface Crypto {
    randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  }
}

function formatUuidFromBytes(
  bytes: Uint8Array,
): `${string}-${string}-${string}-${string}-${string}` {
  const normalized = new Uint8Array(bytes);
  normalized[6] = (normalized[6]! & 0x0f) | 0x40;
  normalized[8] = (normalized[8]! & 0x3f) | 0x80;
  const hex = Array.from(normalized, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}` as `${string}-${string}-${string}-${string}-${string}`;
}

export function polyfillCrypto(): void {
  // Ensure TextEncoder/TextDecoder exist for shared E2EE code (tweetnacl + relay transport).
  // Hermes may not provide them in all configurations.
  if (typeof (globalThis as any).TextEncoder !== "function") {
    class BufferTextEncoder {
      encode(input = ""): Uint8Array {
        return Uint8Array.from(Buffer.from(String(input), "utf8"));
      }
    }
    (globalThis as any).TextEncoder = BufferTextEncoder as any;
  }

  if (typeof (globalThis as any).TextDecoder !== "function") {
    class BufferTextDecoder {
      constructor(_label?: string, _options?: unknown) {
        // no-op
      }
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
    (globalThis as any).TextDecoder = BufferTextDecoder as any;
  }

  const existing = (globalThis as any).crypto as Crypto | null | undefined;
  const nativeGetRandomValues =
    existing && typeof existing.getRandomValues === "function"
      ? existing.getRandomValues.bind(existing)
      : null;
  const fillRandomValues = <T extends ArrayBufferView>(array: T): T => {
    if (nativeGetRandomValues) {
      return nativeGetRandomValues(array);
    }
    return ExpoCrypto.getRandomValues(array as any) as T;
  };
  let target = existing;
  if (!target) {
    target = {} as Crypto;
    (globalThis as any).crypto = target;
  }

  if (typeof (globalThis as any).crypto?.randomUUID !== "function") {
    if (!globalThis.crypto) {
      (globalThis as any).crypto = {} as Crypto;
    }
    globalThis.crypto.randomUUID = () => formatUuidFromBytes(fillRandomValues(new Uint8Array(16)));
  }

  if (typeof (globalThis as any).crypto?.getRandomValues !== "function") {
    if (!globalThis.crypto) {
      (globalThis as any).crypto = {} as Crypto;
    }
    globalThis.crypto.getRandomValues = fillRandomValues;
  }
}

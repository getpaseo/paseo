import * as ExpoCrypto from "expo-crypto";
import { Buffer } from "buffer";

declare global {
  interface Crypto {
    randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  }
}

interface MutableGlobal {
  TextEncoder?: typeof TextEncoder;
  TextDecoder?: typeof TextDecoder;
  crypto?: Crypto;
}

export function polyfillCrypto(): void {
  const g = globalThis as unknown as MutableGlobal;

  // Ensure TextEncoder/TextDecoder exist for shared E2EE code (tweetnacl + relay transport).
  // Hermes may not provide them in all configurations.
  if (typeof g.TextEncoder !== "function") {
    class BufferTextEncoder {
      encode(input = ""): Uint8Array {
        return Uint8Array.from(Buffer.from(input, "utf8"));
      }
    }
    g.TextEncoder = BufferTextEncoder as unknown as typeof TextEncoder;
  }

  if (typeof g.TextDecoder !== "function") {
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
    g.TextDecoder = BufferTextDecoder as unknown as typeof TextDecoder;
  }

  if (!g.crypto) {
    g.crypto = {} as Crypto;
  }

  if (typeof g.crypto.randomUUID !== "function") {
    g.crypto.randomUUID = () =>
      ExpoCrypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  }

  if (typeof g.crypto.getRandomValues !== "function") {
    g.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array;
      return ExpoCrypto.getRandomValues(
        array as unknown as Parameters<typeof ExpoCrypto.getRandomValues>[0],
      ) as unknown as T;
    };
  }
}

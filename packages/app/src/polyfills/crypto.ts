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
        return Uint8Array.from(Buffer.from(String(input), "utf8"));
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

  if (typeof g.crypto.getRandomValues !== "function") {
    g.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array;
      return ExpoCrypto.getRandomValues(
        array as unknown as Parameters<typeof ExpoCrypto.getRandomValues>[0],
      ) as unknown as T;
    };
  }

  if (typeof g.crypto.randomUUID !== "function") {
    g.crypto.randomUUID = (() => {
      const bytes = new Uint8Array(16);
      g.crypto!.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex: string[] = [];
      for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
      const h = hex.join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}` as `${string}-${string}-${string}-${string}-${string}`;
    }) as Crypto["randomUUID"];
  }
}

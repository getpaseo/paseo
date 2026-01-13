import * as ExpoCrypto from "expo-crypto";

declare global {
  interface Crypto {
    randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  }
}

export function polyfillCrypto(): void {
  if (typeof globalThis.crypto === "undefined") {
    (globalThis as any).crypto = {};
  }

  if (typeof globalThis.crypto.randomUUID !== "function") {
    globalThis.crypto.randomUUID = () =>
      ExpoCrypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  }

  if (typeof globalThis.crypto.getRandomValues !== "function") {
    globalThis.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
      return ExpoCrypto.getRandomValues(array as any) as T;
    };
  }
}

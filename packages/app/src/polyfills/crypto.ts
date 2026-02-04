import * as ExpoCrypto from "expo-crypto";

declare global {
  interface Crypto {
    randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  }
}

export function polyfillCrypto(): void {
  let webcrypto: Crypto | null = null;
  try {
    // Prefer the React Native entrypoint to avoid the browser shim.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnModule = require("@sphereon/isomorphic-webcrypto/src/react-native");
    webcrypto = (rnModule?.default ?? rnModule) as Crypto;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fallbackModule = require("@sphereon/isomorphic-webcrypto");
    webcrypto = (fallbackModule?.default ?? fallbackModule) as Crypto;
  }

  const existing = (globalThis as any).crypto as Crypto | null | undefined;
  let target = existing;
  if (!target || typeof (target as Crypto).subtle === "undefined") {
    target = (webcrypto && typeof webcrypto === "object" ? (webcrypto as Crypto) : undefined) ?? ({} as Crypto);
    (globalThis as any).crypto = target;
  }

  const ensureSecure = (globalThis as any).crypto?.ensureSecure as
    | (() => Promise<void>)
    | undefined;
  if (typeof ensureSecure === "function") {
    void ensureSecure();
  }

  if (typeof (globalThis as any).crypto?.randomUUID !== "function") {
    if (!globalThis.crypto) {
      (globalThis as any).crypto = {} as Crypto;
    }
    globalThis.crypto.randomUUID = () =>
      ExpoCrypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  }

  if (typeof (globalThis as any).crypto?.getRandomValues !== "function") {
    if (!globalThis.crypto) {
      (globalThis as any).crypto = {} as Crypto;
    }
    globalThis.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
      return ExpoCrypto.getRandomValues(array as any) as T;
    };
  }
}

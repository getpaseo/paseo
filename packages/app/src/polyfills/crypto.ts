import * as ExpoCrypto from "expo-crypto";
import { installCryptoPolyfills, type CryptoPolyfillTarget } from "./install-crypto-polyfills";

export function polyfillCrypto(): void {
  installCryptoPolyfills(globalThis as unknown as CryptoPolyfillTarget, {
    expoGetRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
      ExpoCrypto.getRandomValues(
        array as unknown as Parameters<typeof ExpoCrypto.getRandomValues>[0],
      ) as unknown as T,
  });
}

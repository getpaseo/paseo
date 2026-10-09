import * as ExpoCrypto from "expo-crypto";
import { installCryptoPolyfills, type CryptoPolyfillTarget } from "./install-crypto-polyfills";
interface NativeRandomSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

export function installRuntimeCrypto(
  target: CryptoPolyfillTarget,
  source: NativeRandomSource,
): void {
  installCryptoPolyfills(target, {
    expoGetRandomValues: (array) => source.getRandomValues(array),
  });
}

export function polyfillCrypto(): void {
  installRuntimeCrypto(globalThis as unknown as CryptoPolyfillTarget, {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
      ExpoCrypto.getRandomValues(
        array as unknown as Parameters<typeof ExpoCrypto.getRandomValues>[0],
      ) as unknown as T,
  });
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const expoCryptoMock = vi.hoisted(() => ({
  getRandomValues: vi.fn(<T extends ArrayBufferView>(array: T) => array),
}));

vi.mock("expo-crypto", () => expoCryptoMock);

describe("polyfillCrypto", () => {
  beforeEach(() => {
    vi.resetModules();
    expoCryptoMock.getRandomValues.mockClear();
  });

  it("adds a non-recursive randomUUID when only getRandomValues exists", async () => {
    const originalCrypto = globalThis.crypto;
    const nativeGetRandomValues = vi.fn(<T extends ArrayBufferView>(array: T) => {
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      view.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return array;
    });

    try {
      Object.defineProperty(globalThis, "crypto", {
        value: { getRandomValues: nativeGetRandomValues },
        configurable: true,
      });

      const mod = await import("./crypto");
      mod.polyfillCrypto();

      const uuid = globalThis.crypto.randomUUID();
      expect(uuid).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
      expect(nativeGetRandomValues).toHaveBeenCalledTimes(1);
      expect(expoCryptoMock.getRandomValues).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
      });
    }
  });
});

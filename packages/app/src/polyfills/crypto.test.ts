import { beforeEach, describe, expect, it, vi } from "vitest";

const expoCryptoMock = vi.hoisted(() => ({
  getRandomValues: vi.fn(<T extends ArrayBufferView>(array: T): T => array),
  randomUUID: vi.fn(() => {
    throw new Error("ExpoCrypto.randomUUID should not be used for the web fallback");
  }),
}));

vi.mock("expo-crypto", () => expoCryptoMock);

describe("polyfillCrypto", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    expoCryptoMock.getRandomValues.mockClear();
    expoCryptoMock.randomUUID.mockClear();
  });

  it("generates randomUUID from getRandomValues when Web Crypto randomUUID is unavailable", async () => {
    const sourceBytes = Uint8Array.from([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
    const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(array: T): T => {
      if (array && ArrayBuffer.isView(array)) {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(sourceBytes);
      }
      return array;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const { polyfillCrypto } = await import("./crypto");
    polyfillCrypto();

    expect(globalThis.crypto.randomUUID()).toBe("00112233-4455-4677-8899-aabbccddeeff");
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(expoCryptoMock.randomUUID).not.toHaveBeenCalled();
  });
});

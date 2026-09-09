import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => array,
}));

import { installRuntimeCrypto } from "./crypto";

describe("installRuntimeCrypto", () => {
  it("installs UUID support through the supplied native random source", () => {
    const target: Record<string, unknown> = {};
    const requestedLengths: number[] = [];

    installRuntimeCrypto(target, {
      getRandomValues: (array) => {
        if (array) {
          requestedLengths.push(array.byteLength);
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
        }
        return array;
      },
    });

    const uuid = (target.crypto as Crypto).randomUUID();
    expect(uuid).toBe("abababab-abab-4bab-abab-abababababab");
    expect(requestedLengths).toEqual([16]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn<(_: string) => Promise<string | null>>(),
  setItem: vi.fn<(_: string, __: string) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

describe("client-id", () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockReset();
  });

  it("returns stored client id when present", async () => {
    asyncStorageMock.getItem.mockResolvedValue("cid_existing");
    const mod = await import("./client-id");

    const key = await mod.getOrCreateClientId();
    expect(key).toBe("cid_existing");
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });

  it("creates and persists a client id when missing", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "12345678-1234-1234-1234-1234567890ab",
    );

    const mod = await import("./client-id");
    const key = await mod.getOrCreateClientId();

    expect(key).toBe("cid_123456781234123412341234567890ab");
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      "@paseo:client-id-v1",
      "cid_123456781234123412341234567890ab",
    );
  });

  it("falls back to getRandomValues when randomUUID throws", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView>(array: T): T => {
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        view.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return array;
      },
    );

    const mod = await import("./client-id");
    const key = await mod.getOrCreateClientId();

    expect(key).toBe("cid_000102030405060708090a0b0c0d0e0f");
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      "@paseo:client-id-v1",
      "cid_000102030405060708090a0b0c0d0e0f",
    );
  });
});

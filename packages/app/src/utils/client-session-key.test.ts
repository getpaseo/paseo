import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn<(_: string) => Promise<string | null>>(),
  setItem: vi.fn<(_: string, __: string) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

describe("client-session-key", () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockReset();
  });

  it("returns stored client session key when present", async () => {
    asyncStorageMock.getItem.mockResolvedValue("clsk_existing");
    const mod = await import("./client-session-key");

    const key = await mod.getOrCreateClientSessionKey();
    expect(key).toBe("clsk_existing");
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });

  it("creates and persists a client session key when missing", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("12345678-1234-1234-1234-1234567890ab");

    const mod = await import("./client-session-key");
    const key = await mod.getOrCreateClientSessionKey();

    expect(key).toBe("clsk_123456781234123412341234567890ab");
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      "@paseo:client-session-key-v1",
      "clsk_123456781234123412341234567890ab"
    );
  });
});

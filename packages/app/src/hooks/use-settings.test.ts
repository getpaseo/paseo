import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn<(_: string) => Promise<string | null>>(),
  setItem: vi.fn<(_: string, __: string) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

describe("use-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockReset();
  });

  it("defaults built-in daemon management to enabled when storage is empty", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result).toEqual(mod.DEFAULT_APP_SETTINGS);
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      mod.APP_SETTINGS_KEY,
      JSON.stringify(mod.DEFAULT_APP_SETTINGS),
    );
  });

  it("defaults theme to auto when storage is empty", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result.theme).toBe("auto");
  });

  it("defaults the native history bootstrap limit to a bounded mobile window", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result.nativeInitialTimelineLimit).toBe(100);
  });

  it("loads persisted built-in daemon management state and normalizes the native limit", async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "@paseo:app-settings") {
        return JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
          nativeInitialTimelineLimit: 500,
        });
      }
      return null;
    });

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result).toEqual({
      theme: "light",
      manageBuiltInDaemon: false,
      sendBehavior: "interrupt",
      nativeInitialTimelineLimit: 500,
    });
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });
});

describe("app settings normalization", () => {
  it("accepts supported native initial timeline limits", async () => {
    const mod = await import("./use-settings");

    expect(mod.__private__.normalizeNativeInitialTimelineLimit(500)).toBe(500);
    expect(mod.__private__.normalizeNativeInitialTimelineLimit(0)).toBe(0);
  });

  it("falls back to the default limit for unsupported values", async () => {
    const mod = await import("./use-settings");

    expect(mod.__private__.normalizeNativeInitialTimelineLimit(-1)).toBe(
      mod.DEFAULT_APP_SETTINGS.nativeInitialTimelineLimit,
    );
    expect(mod.__private__.normalizeNativeInitialTimelineLimit(123)).toBe(
      mod.DEFAULT_APP_SETTINGS.nativeInitialTimelineLimit,
    );
    expect(mod.__private__.normalizeNativeInitialTimelineLimit("500")).toBe(
      mod.DEFAULT_APP_SETTINGS.nativeInitialTimelineLimit,
    );
  });
});

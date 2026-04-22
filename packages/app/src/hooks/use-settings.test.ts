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

  it("defaults release channel to stable when storage is empty", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result.releaseChannel).toBe("stable");
  });

  it("loads persisted built-in daemon management state", async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "@paseo:app-settings") {
        return JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
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
      releaseChannel: "stable",
    });
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });

  it("loads persisted beta release channel", async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "@paseo:app-settings") {
        return JSON.stringify({
          releaseChannel: "beta",
        });
      }
      return null;
    });

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result.releaseChannel).toBe("beta");
  });
});

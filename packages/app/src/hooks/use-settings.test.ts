import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn<(_: string) => Promise<string | null>>(),
  setItem: vi.fn<(_: string, __: string) => Promise<void>>(),
}));

const electronRuntimeState = vi.hoisted(() => ({
  isElectron: false,
}));

const desktopSettingsMock = vi.hoisted(() => ({
  loadDesktopSettings: vi.fn<() => Promise<unknown>>(),
  migrateLegacyDesktopSettings: vi.fn<(_: unknown) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

vi.mock("@/desktop/host", () => ({
  isElectronRuntime: () => electronRuntimeState.isElectron,
}));

vi.mock("@/desktop/settings/desktop-settings", () => desktopSettingsMock);

describe("use-settings", () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockReset();
    electronRuntimeState.isElectron = false;
    desktopSettingsMock.loadDesktopSettings.mockReset();
    desktopSettingsMock.migrateLegacyDesktopSettings.mockReset();
  });

  it("defaults built-in daemon management to enabled when storage is empty", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result).toEqual(mod.DEFAULT_APP_SETTINGS);
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      mod.APP_SETTINGS_KEY,
      JSON.stringify(mod.DEFAULT_CLIENT_SETTINGS),
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

  it("ignores renderer-owned daemon management state outside Electron", async () => {
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
      manageBuiltInDaemon: true,
      sendBehavior: "interrupt",
      serviceUrlBehavior: "ask",
      releaseChannel: "stable",
    });
  });

  it("ignores renderer-owned release channel outside Electron", async () => {
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

    expect(result.releaseChannel).toBe("stable");
  });

  it("keeps legacy AsyncStorage migration for client settings only", async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "@paseo:app-settings") {
        return null;
      }
      if (key === "@paseo:settings") {
        return JSON.stringify({
          theme: "dark",
          manageBuiltInDaemon: false,
          releaseChannel: "beta",
        });
      }
      return null;
    });
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-settings");
    const result = await mod.loadAppSettingsFromStorage();

    expect(result).toEqual({
      theme: "dark",
      sendBehavior: "interrupt",
      serviceUrlBehavior: "ask",
    });
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      mod.APP_SETTINGS_KEY,
      JSON.stringify(result),
    );
  });

  it("migrates legacy desktop-owned settings through Electron before reading effective settings", async () => {
    electronRuntimeState.isElectron = true;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "@paseo:app-settings") {
        return JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
          releaseChannel: "beta",
        });
      }
      return null;
    });
    desktopSettingsMock.migrateLegacyDesktopSettings.mockResolvedValue();
    desktopSettingsMock.loadDesktopSettings.mockResolvedValue({
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    });

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(desktopSettingsMock.migrateLegacyDesktopSettings).toHaveBeenCalledWith({
      manageBuiltInDaemon: false,
      releaseChannel: "beta",
    });
    expect(result).toEqual({
      theme: "light",
      sendBehavior: "interrupt",
      serviceUrlBehavior: "ask",
      manageBuiltInDaemon: false,
      releaseChannel: "beta",
    });
  });

  it("skips desktop IPC when loading effective settings outside Electron", async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      JSON.stringify({
        theme: "light",
      }),
    );

    const mod = await import("./use-settings");
    const result = await mod.loadSettingsFromStorage();

    expect(result).toEqual({
      theme: "light",
      sendBehavior: "interrupt",
      serviceUrlBehavior: "ask",
      manageBuiltInDaemon: true,
      releaseChannel: "stable",
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettingsStore } from "./desktop-settings";
import { createDesktopSettingsCommandHandlers } from "./desktop-settings-commands";
import type { SettingsSeedDocument } from "./settings-seed";

function createHandlers(
  store: DesktopSettingsStore,
  loadSettingsSeed: () => Promise<SettingsSeedDocument | null> = async () => null,
) {
  return createDesktopSettingsCommandHandlers({ settingsStore: store, loadSettingsSeed });
}

function createStoreMock(): DesktopSettingsStore {
  return {
    get: vi.fn(async () => DEFAULT_DESKTOP_SETTINGS),
    patch: vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    })),
    migrateLegacyRendererSettings: vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    })),
  };
}

describe("desktop-settings-commands", () => {
  it("exposes get and patch handlers through the desktop command bus shape", async () => {
    const store = createStoreMock();
    const handlers = createHandlers(store);

    await expect(handlers.get_desktop_settings()).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS);
    await expect(
      handlers.patch_desktop_settings({
        daemon: { keepRunningAfterQuit: false },
      }),
    ).resolves.toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    });

    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.patch).toHaveBeenCalledWith({
      daemon: { keepRunningAfterQuit: false },
    });
  });

  it("accepts legacy renderer settings migration payloads", async () => {
    const store = createStoreMock();
    const handlers = createHandlers(store);

    const result = await handlers.migrate_legacy_desktop_settings({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
    });

    expect(result).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: true,
      },
    });
    expect(store.migrateLegacyRendererSettings).toHaveBeenCalledWith({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
    });
  });

  it("returns null from get_settings_seed when there is no seed file", async () => {
    const handlers = createHandlers(createStoreMock(), async () => null);

    await expect(handlers.get_settings_seed()).resolves.toBeNull();
  });

  it("exposes only the path and app section of the seed", async () => {
    const handlers = createHandlers(createStoreMock(), async () => ({
      path: "/home/user/.config/Paseo/settings-seed.json",
      app: { theme: "dark" },
      desktop: { releaseChannel: "beta" },
    }));

    await expect(handlers.get_settings_seed()).resolves.toEqual({
      path: "/home/user/.config/Paseo/settings-seed.json",
      app: { theme: "dark" },
    });
  });

  it("rejects get_settings_seed when the seed file cannot be parsed", async () => {
    const handlers = createHandlers(createStoreMock(), async () => {
      throw new Error("[SettingsSeed] Invalid JSON in /tmp/settings-seed.json: bad");
    });

    await expect(handlers.get_settings_seed()).rejects.toThrow("Invalid JSON");
  });

  it("re-reads the seed on every invoke", async () => {
    const loadSettingsSeed = vi.fn(async () => null);
    const handlers = createHandlers(createStoreMock(), loadSettingsSeed);

    await handlers.get_settings_seed();
    await handlers.get_settings_seed();

    expect(loadSettingsSeed).toHaveBeenCalledTimes(2);
  });
});

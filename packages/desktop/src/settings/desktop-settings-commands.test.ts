import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettingsStore } from "./desktop-settings";
import { createDesktopSettingsCommandHandlers } from "./desktop-settings-commands";

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
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

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
    const handlers = createDesktopSettingsCommandHandlers({ settingsStore: store });

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
});

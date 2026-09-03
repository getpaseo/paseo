import { describe, expect, it, vi } from "vitest";

import type { ClientSettingsDocument, ClientSettingsStore } from "./client-settings";
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettingsStore } from "./desktop-settings";
import { createDesktopSettingsCommandHandlers } from "./desktop-settings-commands";
import type { SettingsSeedDocument } from "./settings-seed";

/** An in-memory stand-in for the settings.json file the store owns. */
function createClientSettingsStoreMock(initial: Record<string, unknown> | null = null) {
  let app = initial;
  const store: ClientSettingsStore = {
    get: vi.fn(async () => (app ? ({ version: 1, app } as ClientSettingsDocument) : null)),
    setField: vi.fn(async (field: string, value: unknown) => {
      app ??= {};
      if (value === null) {
        delete app[field];
      } else {
        app[field] = value;
      }
      return { version: 1, app } as ClientSettingsDocument;
    }),
    initialize: vi.fn(async (entries: Record<string, unknown>) => {
      app ??= { ...entries };
      return { version: 1, app } as ClientSettingsDocument;
    }),
  };
  return store;
}

function createHandlers(
  store: DesktopSettingsStore,
  loadSettingsSeed: () => Promise<SettingsSeedDocument | null> = async () => null,
  clientSettingsStore: ClientSettingsStore = createClientSettingsStoreMock(),
) {
  return createDesktopSettingsCommandHandlers({
    settingsStore: store,
    clientSettingsStore,
    loadSettingsSeed,
  });
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

  it("returns null from get_client_settings when there is no settings file", async () => {
    const handlers = createHandlers(createStoreMock(), undefined, createClientSettingsStoreMock());

    await expect(handlers.get_client_settings()).resolves.toBeNull();
  });

  it("sets and deletes a single client settings field", async () => {
    const clientSettings = createClientSettingsStoreMock({});
    const handlers = createHandlers(createStoreMock(), undefined, clientSettings);

    await handlers.set_client_setting({ field: "preferredEditor", value: "zed" });
    await expect(handlers.get_client_settings()).resolves.toEqual({
      version: 1,
      app: { preferredEditor: "zed" },
    });

    await handlers.set_client_setting({ field: "preferredEditor", value: null });
    await expect(handlers.get_client_settings()).resolves.toEqual({ version: 1, app: {} });
  });

  it("rejects a set without a field name", async () => {
    const handlers = createHandlers(createStoreMock());

    expect(() => handlers.set_client_setting({ value: "zed" })).toThrow("requires a field name");
  });

  it("initializes the client settings file with bulk entries", async () => {
    const clientSettings = createClientSettingsStoreMock(null);
    const handlers = createHandlers(createStoreMock(), undefined, clientSettings);

    await expect(
      handlers.initialize_client_settings({ entries: { preferredEditor: "zed" } }),
    ).resolves.toEqual({ version: 1, app: { preferredEditor: "zed" } });
    expect(clientSettings.initialize).toHaveBeenCalledWith({ preferredEditor: "zed" });
  });

  it("initializes with an empty document when entries are missing", async () => {
    const clientSettings = createClientSettingsStoreMock(null);
    const handlers = createHandlers(createStoreMock(), undefined, clientSettings);

    await expect(handlers.initialize_client_settings()).resolves.toEqual({ version: 1, app: {} });
  });
});

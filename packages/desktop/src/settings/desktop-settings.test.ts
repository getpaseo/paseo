import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
  createDesktopSettingsStore as createDesktopSettingsStoreForPlatform,
} from "./desktop-settings";
import { loadSettingsSeed } from "./settings-seed";

function createDesktopSettingsStore(
  options: Parameters<typeof createDesktopSettingsStoreForPlatform>[0],
) {
  return createDesktopSettingsStoreForPlatform({
    ...options,
    loadSeed:
      options.loadSeed ??
      (() =>
        loadSettingsSeed({
          userDataPath: options.userDataPath,
          platform: "darwin",
        })),
  });
}

async function createTempUserDataDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-settings-"));
}

function settingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, "desktop-settings.json");
}

async function writeSeed(userDataPath: string, seed: unknown): Promise<void> {
  await writeFile(path.join(userDataPath, "settings-seed.json"), JSON.stringify(seed));
}

function silence(): void {}

async function readPersistedSettings(userDataPath: string): Promise<unknown> {
  const document = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
    settings: unknown;
  };
  return document.settings;
}

describe("desktop-settings", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  it("persists default settings for new users", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      settings: DesktopSettings;
    };

    expect(settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(persisted.settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("handles concurrent first-launch reads without racing the settings write", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await Promise.all(Array.from({ length: 20 }, () => store.get()));
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      settings: DesktopSettings;
    };
    const files = await readdir(userDataPath);

    expect(settings).toEqual(Array.from({ length: 20 }, () => DEFAULT_DESKTOP_SETTINGS));
    expect(persisted.settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(files).toEqual(["desktop-settings.json"]);
  });

  it("coerces invalid persisted values back to safe defaults", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "nightly",
          daemon: {
            manageBuiltInDaemon: "sometimes",
            keepRunningAfterQuit: false,
          },
        },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();

    expect(settings).toEqual({
      releaseChannel: "stable",
      notifications: { playSound: true },
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: false,
      },
    });
  });

  it("patches nested settings and leaves no temp files behind", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    await store.get();
    const next = await store.patch({
      releaseChannel: "beta",
      daemon: { keepRunningAfterQuit: false },
    });
    const files = await readdir(userDataPath);

    expect(next).toEqual({
      releaseChannel: "beta",
      notifications: { playSound: true },
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: false,
      },
    });
    expect(files).toEqual(["desktop-settings.json"]);
  });

  it("defaults notification sounds on for existing settings documents", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          daemon: {
            manageBuiltInDaemon: true,
            keepRunningAfterQuit: false,
          },
        },
        migrations: {
          legacyRendererSettingsImported: true,
          daemonStopOnQuitDefaultApplied: true,
        },
      }),
    );

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.notifications.playSound).toBe(true);
  });

  it("keeps an explicit notification sound choice across restarts", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);

    await createDesktopSettingsStore({ userDataPath }).patch({
      notifications: { playSound: false },
    });

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.notifications.playSound).toBe(false);
  });

  it("does not let stale legacy renderer settings override an explicit desktop patch", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const patched = await store.patch({
      daemon: {
        manageBuiltInDaemon: false,
      },
    });
    const migrated = await store.migrateLegacyRendererSettings({
      manageBuiltInDaemon: true,
      releaseChannel: "beta",
    });
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      migrations: { legacyRendererSettingsImported: boolean };
      settings: DesktopSettings;
    };

    expect(patched.daemon.manageBuiltInDaemon).toBe(false);
    expect(migrated.daemon.manageBuiltInDaemon).toBe(false);
    expect(migrated.releaseChannel).toBe("stable");
    expect(persisted.migrations.legacyRendererSettingsImported).toBe(true);
    expect(persisted.settings.daemon.manageBuiltInDaemon).toBe(false);
  });

  it("does not rewrite existing settings while reading them", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const raw = JSON.stringify({
      version: 1,
      settings: {
        releaseChannel: "stable",
        daemon: {
          manageBuiltInDaemon: false,
          keepRunningAfterQuit: true,
        },
      },
      migrations: {
        legacyRendererSettingsImported: false,
      },
    });
    await writeFile(settingsFilePath(userDataPath), raw);
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();
    const persisted = await readFile(settingsFilePath(userDataPath), "utf8");

    expect(settings.daemon.manageBuiltInDaemon).toBe(false);
    expect(persisted).toBe(raw);
  });

  it("resets the pre-existing keep-running default so the daemon stops with the app", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
        },
        migrations: { legacyRendererSettingsImported: true },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();

    expect(settings.daemon.keepRunningAfterQuit).toBe(false);
  });

  it("keeps an explicit keep-running choice across restarts", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
        },
        migrations: { legacyRendererSettingsImported: true },
      }),
    );
    await createDesktopSettingsStore({ userDataPath }).patch({
      daemon: { keepRunningAfterQuit: true },
    });

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.daemon.keepRunningAfterQuit).toBe(true);
  });

  it("migrates desktop-owned values from legacy renderer settings once", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    await store.patch({
      daemon: {
        keepRunningAfterQuit: false,
      },
    });

    const migrated = await store.migrateLegacyRendererSettings({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
      theme: "dark",
    });
    const ignoredSecondMigration = await store.migrateLegacyRendererSettings({
      releaseChannel: "stable",
      manageBuiltInDaemon: true,
    });

    expect(migrated).toEqual({
      releaseChannel: "beta",
      notifications: { playSound: true },
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: false,
      },
    });
    expect(ignoredSecondMigration).toEqual(migrated);
  });

  describe("settings seed", () => {
    it("layers the seed under the persisted settings without copying it into them", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, {
        app: { theme: "dark" },
        desktop: { releaseChannel: "beta", daemon: { manageBuiltInDaemon: false } },
      });
      const store = createDesktopSettingsStore({ userDataPath });

      const settings = await store.get();

      expect(settings).toEqual({
        releaseChannel: "beta",
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false },
      });
      expect(await readPersistedSettings(userDataPath)).toEqual({});
    });

    it("persists only the difference against the seed", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, {
        desktop: { releaseChannel: "beta", daemon: { manageBuiltInDaemon: false } },
      });
      const store = createDesktopSettingsStore({ userDataPath });

      const next = await store.patch({
        releaseChannel: "beta",
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
      });

      expect(next).toEqual({
        releaseChannel: "beta",
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
      });
      expect(await readPersistedSettings(userDataPath)).toEqual({
        daemon: { keepRunningAfterQuit: true },
      });
    });

    it("drops a local override once it matches the seed again", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, { desktop: { releaseChannel: "beta" } });
      const store = createDesktopSettingsStore({ userDataPath });

      await store.patch({ releaseChannel: "stable" });
      const overridden = await readPersistedSettings(userDataPath);
      const restored = await store.patch({ releaseChannel: "beta" });

      expect(overridden).toEqual({ releaseChannel: "stable" });
      expect(restored.releaseChannel).toBe("beta");
      expect(await readPersistedSettings(userDataPath)).toEqual({});
    });

    it("applies later seed edits to values the user never overrode", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, { desktop: { releaseChannel: "beta" } });
      const store = createDesktopSettingsStore({ userDataPath });

      await store.patch({ daemon: { keepRunningAfterQuit: true } });
      await writeSeed(userDataPath, { desktop: { releaseChannel: "stable" } });
      const settings = await store.get();

      expect(settings).toEqual({
        releaseChannel: "stable",
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
      });
    });

    it("ignores invalid seed fields", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, {
        desktop: {
          releaseChannel: "nightly",
          daemon: { manageBuiltInDaemon: "yes", keepRunningAfterQuit: true },
        },
      });
      const store = createDesktopSettingsStore({ userDataPath });

      const settings = await store.get();

      expect(settings).toEqual({
        releaseChannel: "stable",
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
      });
    });

    it("keeps working when the seed file cannot be read", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      const consoleError = vi.spyOn(console, "error").mockImplementation(silence);
      const store = createDesktopSettingsStore({
        userDataPath,
        loadSeed: async () => {
          throw new Error("[SettingsSeed] Invalid JSON in settings-seed.json: unexpected token");
        },
      });

      const settings = await store.get();
      const patched = await store.patch({ releaseChannel: "beta" });

      expect(settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
      expect(patched.releaseChannel).toBe("beta");
      // No seed means no delta layer: the file still holds the full settings.
      expect(await readPersistedSettings(userDataPath)).toEqual({
        releaseChannel: "beta",
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
      });
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("switches to delta persistence for a seed that only carries app settings", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, { app: { theme: "dark" } });
      const store = createDesktopSettingsStore({ userDataPath });

      const settings = await store.get();
      await store.patch({ daemon: { manageBuiltInDaemon: true } });

      expect(settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
      expect(await readPersistedSettings(userDataPath)).toEqual({});
    });

    it("keeps a stored full-settings document readable by older versions", async () => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      await writeSeed(userDataPath, { desktop: { releaseChannel: "beta" } });
      await writeFile(
        settingsFilePath(userDataPath),
        JSON.stringify({
          version: 1,
          settings: {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
          },
          migrations: {
            legacyRendererSettingsImported: true,
            daemonStopOnQuitDefaultApplied: true,
          },
        }),
      );
      const store = createDesktopSettingsStore({ userDataPath });

      // A document written before the seed existed shadows it until the next patch
      // rewrites the delta.
      const shadowed = await store.get();
      await store.patch({ daemon: { manageBuiltInDaemon: false } });

      expect(shadowed.releaseChannel).toBe("stable");
      expect(await readPersistedSettings(userDataPath)).toEqual({
        releaseChannel: "stable",
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
      });
    });
  });

  it("keeps keys written by another build across a patch", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        futureDocumentKey: "kept",
        settings: {
          releaseChannel: "beta",
          tray: { enabled: true },
          daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false, futureFlag: 7 },
        },
        migrations: {
          legacyRendererSettingsImported: true,
          daemonStopOnQuitDefaultApplied: true,
          futureMigrationApplied: true,
        },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    const next = await store.patch({ notifications: { playSound: false } });
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      futureDocumentKey: string;
      settings: { releaseChannel: string; tray: unknown; daemon: Record<string, unknown> };
      migrations: Record<string, boolean>;
    };

    expect(persisted.settings.tray).toEqual({ enabled: true });
    expect(persisted.settings.daemon.futureFlag).toBe(7);
    expect(persisted.migrations.futureMigrationApplied).toBe(true);
    expect(persisted.futureDocumentKey).toBe("kept");
    expect(persisted.settings.releaseChannel).toBe("beta");
    expect(next).toEqual({
      releaseChannel: "beta",
      notifications: { playSound: false },
      daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
    });
  });

  it("keeps keys written by another build across the legacy renderer migration", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: { tray: { enabled: true } },
        migrations: { legacyRendererSettingsImported: false, daemonStopOnQuitDefaultApplied: true },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    await store.migrateLegacyRendererSettings({ releaseChannel: "beta" });
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      settings: { releaseChannel: string; tray: unknown };
    };

    expect(persisted.settings.tray).toEqual({ enabled: true });
    expect(persisted.settings.releaseChannel).toBe("beta");
  });

  it("replaces an unusable modelled value on the write path", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: { releaseChannel: "nightly", tray: { enabled: true } },
        migrations: { legacyRendererSettingsImported: true, daemonStopOnQuitDefaultApplied: true },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    await store.patch({ notifications: { playSound: false } });
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      settings: { releaseChannel: string; tray: unknown };
    };

    expect(persisted.settings.releaseChannel).toBe("stable");
    expect(persisted.settings.tray).toEqual({ enabled: true });
  });
});

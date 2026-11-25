import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
  createDesktopSettingsStore,
} from "./desktop-settings";

async function createTempUserDataDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-settings-"));
}

function settingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, "desktop-settings.json");
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
      updates: { mode: "automatic" },
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
      updates: { mode: "notify" },
      daemon: { keepRunningAfterQuit: false },
    });
    const files = await readdir(userDataPath);

    expect(next).toEqual({
      releaseChannel: "beta",
      updates: { mode: "notify" },
      notifications: { playSound: true },
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: false,
      },
    });
    expect(files).toEqual(["desktop-settings.json"]);
  });

  it("defaults updates.mode to automatic and persists explicit choices across restarts", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          updates: { mode: "invalid" },
        },
        migrations: {
          legacyRendererSettingsImported: true,
          daemonStopOnQuitDefaultApplied: true,
        },
      }),
    );

    const defaulted = await createDesktopSettingsStore({ userDataPath }).get();
    expect(defaulted.updates.mode).toBe("automatic");

    await createDesktopSettingsStore({ userDataPath }).patch({ updates: { mode: "off" } });
    const persisted = await createDesktopSettingsStore({ userDataPath }).get();
    expect(persisted.updates.mode).toBe("off");
  });

  it("serializes overlapping patches so neither update mode nor release channel is lost", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const [offResult, betaResult] = await Promise.all([
      store.patch({ updates: { mode: "off" } }),
      store.patch({ releaseChannel: "beta" }),
    ]);

    expect(offResult.updates.mode).toBe("off");
    expect(betaResult.updates.mode).toBe("off");
    expect(betaResult.releaseChannel).toBe("beta");

    const reloaded = await createDesktopSettingsStore({ userDataPath }).get();
    expect(reloaded.updates.mode).toBe("off");
    expect(reloaded.releaseChannel).toBe("beta");
  });

  it("waits for an in-flight patch before resolving get() from cache", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    await store.patch({ updates: { mode: "off" } });
    const patchPromise = store.patch({ updates: { mode: "automatic" } });
    const readDuringPatch = store.get();

    const [patched, read] = await Promise.all([patchPromise, readDuringPatch]);
    expect(patched.updates.mode).toBe("automatic");
    expect(read.updates.mode).toBe("automatic");
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
      updates: { mode: "automatic" },
      notifications: { playSound: true },
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: false,
      },
    });
    expect(ignoredSecondMigration).toEqual(migrated);
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
      updates: { mode: "automatic" },
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

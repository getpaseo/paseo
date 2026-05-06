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
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: false,
      },
    });
    expect(files).toEqual(["desktop-settings.json"]);
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
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: false,
      },
    });
    expect(ignoredSecondMigration).toEqual(migrated);
  });
});

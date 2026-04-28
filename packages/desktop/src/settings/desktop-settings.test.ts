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

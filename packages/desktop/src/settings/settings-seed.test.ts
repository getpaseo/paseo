import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getSettingsSeedPath, loadSettingsSeed } from "./settings-seed";

const directories = new Set<string>();

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-settings-seed-"));
  directories.add(directory);
  return directory;
}

function seedFilePath(userDataPath: string): string {
  return path.join(userDataPath, "settings-seed.json");
}

function loadTestSettingsSeed(userDataPath: string) {
  return loadSettingsSeed({
    userDataPath,
    env: {},
    platform: "linux",
    homeDirectory: userDataPath,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("settings-seed", () => {
  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  it("returns null when the seed file does not exist", async () => {
    const userDataPath = await createTempDir();

    await expect(loadTestSettingsSeed(userDataPath)).resolves.toBeNull();
  });

  it("returns null when the seed file is a dangling symlink", async () => {
    const userDataPath = await createTempDir();
    await symlink(path.join(userDataPath, "missing.json"), seedFilePath(userDataPath));

    await expect(loadTestSettingsSeed(userDataPath)).resolves.toBeNull();
  });

  it("parses app and desktop sections and reports the absolute path", async () => {
    const userDataPath = await createTempDir();
    await writeFile(
      seedFilePath(userDataPath),
      JSON.stringify({
        app: { theme: "dark", notifications: { sound: false } },
        desktop: { releaseChannel: "beta", daemon: { keepRunningAfterQuit: true } },
      }),
    );

    const seed = await loadTestSettingsSeed(userDataPath);

    expect(seed).toEqual({
      path: seedFilePath(userDataPath),
      app: { theme: "dark", notifications: { sound: false } },
      desktop: { releaseChannel: "beta", daemon: { keepRunningAfterQuit: true } },
    });
  });

  it("reads through a symlinked seed file", async () => {
    const userDataPath = await createTempDir();
    const dotfilesPath = await createTempDir();
    const sourcePath = path.join(dotfilesPath, "paseo-settings.json");
    await writeFile(sourcePath, JSON.stringify({ app: { theme: "light" } }));
    await symlink(sourcePath, seedFilePath(userDataPath));

    const seed = await loadTestSettingsSeed(userDataPath);

    expect(seed).toEqual({
      path: seedFilePath(userDataPath),
      app: { theme: "light" },
      desktop: undefined,
    });
  });

  it("defaults the app section to an empty object", async () => {
    const userDataPath = await createTempDir();
    await writeFile(
      seedFilePath(userDataPath),
      JSON.stringify({ desktop: { releaseChannel: "beta" } }),
    );

    const seed = await loadTestSettingsSeed(userDataPath);

    expect(seed?.app).toEqual({});
    expect(seed?.desktop).toEqual({ releaseChannel: "beta" });
  });

  it("defaults a non-object app section to an empty object", async () => {
    const userDataPath = await createTempDir();
    await writeFile(seedFilePath(userDataPath), JSON.stringify({ app: ["nope"] }));

    const seed = await loadTestSettingsSeed(userDataPath);

    expect(seed?.app).toEqual({});
  });

  it("throws with the file path when the seed file is not valid JSON", async () => {
    const userDataPath = await createTempDir();
    await writeFile(seedFilePath(userDataPath), "{ nope");

    await expect(loadTestSettingsSeed(userDataPath)).rejects.toThrow(
      new RegExp(`Invalid JSON in ${escapeRegExp(seedFilePath(userDataPath))}`),
    );
  });

  it("throws with the file path when the seed root is not an object", async () => {
    const userDataPath = await createTempDir();
    await writeFile(seedFilePath(userDataPath), JSON.stringify(["app"]));

    await expect(loadTestSettingsSeed(userDataPath)).rejects.toThrow(
      new RegExp(
        `Expected a JSON object at the root of ${escapeRegExp(seedFilePath(userDataPath))}`,
      ),
    );
  });

  it("reflects seed file edits without caching", async () => {
    const userDataPath = await createTempDir();
    await writeFile(seedFilePath(userDataPath), JSON.stringify({ app: { theme: "dark" } }));

    const first = await loadTestSettingsSeed(userDataPath);
    await writeFile(seedFilePath(userDataPath), JSON.stringify({ app: { theme: "light" } }));
    const second = await loadTestSettingsSeed(userDataPath);

    expect(first?.app).toEqual({ theme: "dark" });
    expect(second?.app).toEqual({ theme: "light" });
  });

  it("reads a fresh Linux seed from the XDG config directory", async () => {
    const userDataPath = await createTempDir();
    const homeDirectory = await createTempDir();
    const xdgSeedPath = path.join(homeDirectory, ".config", "paseo", "settings-seed.json");
    await mkdir(path.dirname(xdgSeedPath), { recursive: true });
    await writeFile(xdgSeedPath, JSON.stringify({ app: { theme: "light" } }));

    const seed = await loadSettingsSeed({
      userDataPath,
      env: {},
      platform: "linux",
      homeDirectory,
    });

    expect(seed).toEqual({
      path: xdgSeedPath,
      app: { theme: "light" },
      desktop: undefined,
    });
  });

  it("keeps an existing Linux seed in the legacy user data directory", async () => {
    const userDataPath = await createTempDir();
    const homeDirectory = await createTempDir();
    await writeFile(seedFilePath(userDataPath), JSON.stringify({ app: { theme: "legacy" } }));

    expect(getSettingsSeedPath({ userDataPath, env: {}, platform: "linux", homeDirectory })).toBe(
      seedFilePath(userDataPath),
    );
  });

  it("honors XDG_CONFIG_HOME on Linux", async () => {
    const userDataPath = await createTempDir();
    const homeDirectory = await createTempDir();
    const configRoot = path.join(homeDirectory, "custom-config");

    expect(
      getSettingsSeedPath({
        userDataPath,
        env: { XDG_CONFIG_HOME: configRoot },
        platform: "linux",
        homeDirectory,
      }),
    ).toBe(path.join(configRoot, "paseo", "settings-seed.json"));
  });

  it("allows an explicit seed file on every platform", async () => {
    const userDataPath = await createTempDir();
    const configuredPath = path.join(await createTempDir(), "shared-settings.json");

    expect(
      getSettingsSeedPath({
        userDataPath,
        env: { PASEO_SETTINGS_SEED_FILE: configuredPath },
        platform: "darwin",
      }),
    ).toBe(configuredPath);
  });

  it.each(["darwin", "win32"] as const)(
    "keeps the seed in Electron user data on %s",
    async (platform) => {
      const userDataPath = await createTempDir();

      expect(getSettingsSeedPath({ userDataPath, env: {}, platform })).toBe(
        seedFilePath(userDataPath),
      );
    },
  );
});

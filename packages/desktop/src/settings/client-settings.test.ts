import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createClientSettingsStore, getClientSettingsPath } from "./client-settings";

const directories = new Set<string>();

async function createTempUserDataDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-client-settings-"));
  directories.add(directory);
  return directory;
}

async function readRawDocument(userDataPath: string): Promise<unknown> {
  return JSON.parse(await readFile(getClientSettingsPath(userDataPath), "utf8"));
}

afterEach(async () => {
  await Promise.all(
    [...directories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  directories.clear();
});

describe("client-settings", () => {
  it("reports no document until something is written", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await expect(store.get()).resolves.toBeNull();
  });

  it("writes fields into the app section of a versioned document", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await store.setField("appSettings", { theme: "dark" });
    await store.setField("preferredEditor", "zed");

    await expect(readRawDocument(userDataPath)).resolves.toEqual({
      version: 1,
      app: { appSettings: { theme: "dark" }, preferredEditor: "zed" },
    });
    await expect(store.get()).resolves.toEqual({
      version: 1,
      app: { appSettings: { theme: "dark" }, preferredEditor: "zed" },
    });
  });

  it("deletes a field when the value is null", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await store.setField("preferredEditor", "zed");
    await store.setField("appSettings", { theme: "dark" });
    await store.setField("preferredEditor", null);

    await expect(store.get()).resolves.toEqual({
      version: 1,
      app: { appSettings: { theme: "dark" } },
    });
  });

  it("picks up external edits on the next read", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await store.setField("preferredEditor", "zed");
    await writeFile(
      getClientSettingsPath(userDataPath),
      JSON.stringify({ version: 1, app: { preferredEditor: "vscode" } }),
      "utf8",
    );

    await expect(store.get()).resolves.toEqual({
      version: 1,
      app: { preferredEditor: "vscode" },
    });
  });

  it("serializes concurrent writes so none are lost", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await Promise.all([
      store.setField("appSettings", { theme: "dark" }),
      store.setField("preferredEditor", "zed"),
      store.setField("changesPreferences", { layout: "split" }),
    ]);

    await expect(store.get()).resolves.toEqual({
      version: 1,
      app: {
        appSettings: { theme: "dark" },
        preferredEditor: "zed",
        changesPreferences: { layout: "split" },
      },
    });
  });

  it("initializes the file with bulk entries", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    const document = await store.initialize({ preferredEditor: "zed", appSettings: { a: 1 } });

    expect(document).toEqual({
      version: 1,
      app: { preferredEditor: "zed", appSettings: { a: 1 } },
    });
    await expect(readRawDocument(userDataPath)).resolves.toEqual(document);
  });

  it("never overwrites an existing file on initialize", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await store.setField("preferredEditor", "vscode");
    const document = await store.initialize({ preferredEditor: "zed", appSettings: { a: 1 } });

    expect(document).toEqual({ version: 1, app: { preferredEditor: "vscode" } });
    await expect(store.get()).resolves.toEqual({ version: 1, app: { preferredEditor: "vscode" } });
  });

  it("treats an empty document as existing so initialize stays a one-time step", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await store.initialize({});
    const second = await store.initialize({ preferredEditor: "zed" });

    expect(second).toEqual({ version: 1, app: {} });
  });

  it("throws with the file path when the document is not valid JSON", async () => {
    const userDataPath = await createTempUserDataDir();
    const filePath = getClientSettingsPath(userDataPath);
    await writeFile(filePath, "{ not json", "utf8");
    const store = createClientSettingsStore({ userDataPath });

    await expect(store.get()).rejects.toThrow(`Invalid JSON in ${filePath}`);
    await expect(store.setField("preferredEditor", "zed")).rejects.toThrow(filePath);
    await expect(store.initialize({})).rejects.toThrow(filePath);
  });

  it("throws with the file path when the app section is missing", async () => {
    const userDataPath = await createTempUserDataDir();
    const filePath = getClientSettingsPath(userDataPath);
    await writeFile(filePath, JSON.stringify({ version: 1 }), "utf8");
    const store = createClientSettingsStore({ userDataPath });

    await expect(store.get()).rejects.toThrow(`Expected an "app" object in ${filePath}`);
  });

  it("writes atomically and leaves no temp files behind", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createClientSettingsStore({ userDataPath });

    await store.setField("preferredEditor", "zed");

    expect(await readdir(userDataPath)).toEqual(["settings.json"]);
    const mode = (await stat(getClientSettingsPath(userDataPath))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  coerceQuitDialogCopy,
  createQuitDialogCopyStore,
  DEFAULT_QUIT_DIALOG_COPY,
  type QuitDialogCopy,
} from "./quit-dialog-copy";

const GERMAN: QuitDialogCopy = {
  title: "Paseo beenden?",
  message: "Beim Beenden wird der lokale Daemon gestoppt.",
  quitLabel: "Beenden",
  cancelLabel: "Abbrechen",
  keepDaemonRunningLabel: "Nicht mehr fragen",
};

describe("coerceQuitDialogCopy", () => {
  it("keeps fully translated copy", () => {
    expect(coerceQuitDialogCopy(GERMAN)).toEqual(GERMAN);
  });

  // Per-key, so one missing string doesn't revert the whole dialog to English.
  it("falls back per key", () => {
    const partial = coerceQuitDialogCopy({ title: "Paseo beenden?", quitLabel: "Beenden" });

    expect(partial.title).toBe("Paseo beenden?");
    expect(partial.quitLabel).toBe("Beenden");
    expect(partial.cancelLabel).toBe(DEFAULT_QUIT_DIALOG_COPY.cancelLabel);
    expect(partial.message).toBe(DEFAULT_QUIT_DIALOG_COPY.message);
  });

  it("rejects blank and non-string values", () => {
    expect(coerceQuitDialogCopy({ title: "   ", quitLabel: 7, cancelLabel: null })).toEqual(
      DEFAULT_QUIT_DIALOG_COPY,
    );
  });

  it("falls back entirely for a non-object", () => {
    expect(coerceQuitDialogCopy(null)).toEqual(DEFAULT_QUIT_DIALOG_COPY);
    expect(coerceQuitDialogCopy("nope")).toEqual(DEFAULT_QUIT_DIALOG_COPY);
    expect(coerceQuitDialogCopy([])).toEqual(DEFAULT_QUIT_DIALOG_COPY);
  });
});

describe("quit-dialog-copy store", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.clear();
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-quit-copy-"));
    directories.add(dir);
    return dir;
  }

  it("serves English before the renderer has sent anything", async () => {
    const userDataPath = await tempDir();
    const store = createQuitDialogCopyStore({ userDataPath });

    await store.load();

    expect(store.get()).toEqual(DEFAULT_QUIT_DIALOG_COPY);
  });

  it("round-trips translated copy across a restart", async () => {
    const userDataPath = await tempDir();

    await createQuitDialogCopyStore({ userDataPath }).set(GERMAN);

    // The quit path reads this synchronously, so it has to be right at startup.
    const nextLaunch = createQuitDialogCopyStore({ userDataPath });
    await nextLaunch.load();

    expect(nextLaunch.get()).toEqual(GERMAN);
  });

  it("serves the new copy synchronously right after a language change", async () => {
    const userDataPath = await tempDir();
    const store = createQuitDialogCopyStore({ userDataPath });

    await store.set(GERMAN);

    expect(store.get()).toEqual(GERMAN);
  });

  it("treats a corrupt mirror as a cache miss", async () => {
    const userDataPath = await tempDir();
    await writeFile(path.join(userDataPath, "quit-dialog-copy.json"), "{ not json");
    const store = createQuitDialogCopyStore({ userDataPath });

    await expect(store.load()).resolves.toBeUndefined();
    expect(store.get()).toEqual(DEFAULT_QUIT_DIALOG_COPY);
  });

  it("survives a mirror written with a partial locale", async () => {
    const userDataPath = await tempDir();
    await writeFile(
      path.join(userDataPath, "quit-dialog-copy.json"),
      JSON.stringify({ version: 1, copy: { title: "Paseo beenden?" } }),
    );
    const store = createQuitDialogCopyStore({ userDataPath });

    await store.load();

    expect(store.get().title).toBe("Paseo beenden?");
    expect(store.get().quitLabel).toBe(DEFAULT_QUIT_DIALOG_COPY.quitLabel);
  });
});

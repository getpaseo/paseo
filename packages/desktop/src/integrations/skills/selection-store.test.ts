import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSkillSelectionStore } from "./selection-store";

const directories = new Set<string>();

async function createTempUserDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-skill-selection-"));
  directories.add(dir);
  return dir;
}

function selectionFilePath(userDataPath: string): string {
  return path.join(userDataPath, "skill-selection.json");
}

async function seedSelectionFile(userDataPath: string, raw: string): Promise<void> {
  await writeFile(selectionFilePath(userDataPath), raw, "utf8");
}

afterEach(async () => {
  for (const dir of directories) {
    await rm(dir, { recursive: true, force: true });
  }
  directories.clear();
});

describe("createSkillSelectionStore", () => {
  it("reports all skills when nothing has ever been saved", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createSkillSelectionStore({ userDataPath });

    expect(await store.get()).toEqual({ mode: "all" });
    expect(await readdir(userDataPath)).toEqual([]);
  });

  it("round-trips a custom selection through a fresh store", async () => {
    const userDataPath = await createTempUserDataDir();

    const saved = await createSkillSelectionStore({ userDataPath }).set({
      mode: "custom",
      skills: ["paseo", "paseo-loop"],
    });
    const reloaded = await createSkillSelectionStore({ userDataPath }).get();

    expect(saved).toEqual({ mode: "custom", skills: ["paseo", "paseo-loop"] });
    expect(reloaded).toEqual({ mode: "custom", skills: ["paseo", "paseo-loop"] });
    expect(await readdir(userDataPath)).toEqual(["skill-selection.json"]);
  });

  it("sorts, de-duplicates, and drops non-string names before persisting", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createSkillSelectionStore({ userDataPath });

    const saved = await store.set({
      mode: "custom",
      skills: ["paseo-loop", "paseo", "paseo-loop", "  ", 7, null],
    });

    expect(saved).toEqual({ mode: "custom", skills: ["paseo", "paseo-loop"] });
    expect(JSON.parse(await readFile(selectionFilePath(userDataPath), "utf8"))).toEqual({
      version: 1,
      selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
    });
  });

  it("keeps an empty custom selection as a deliberate choice", async () => {
    const userDataPath = await createTempUserDataDir();

    await createSkillSelectionStore({ userDataPath }).set({ mode: "custom", skills: [] });

    expect(await createSkillSelectionStore({ userDataPath }).get()).toEqual({
      mode: "custom",
      skills: [],
    });
  });

  it("switches back to all and forgets the previous custom names", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createSkillSelectionStore({ userDataPath });
    await store.set({ mode: "custom", skills: ["paseo"] });

    const saved = await store.set({ mode: "all" });

    expect(saved).toEqual({ mode: "all" });
    expect(await createSkillSelectionStore({ userDataPath }).get()).toEqual({ mode: "all" });
  });

  it("falls back to all when the saved file is not valid JSON", async () => {
    const userDataPath = await createTempUserDataDir();
    await seedSelectionFile(userDataPath, "{ not valid json");

    expect(await createSkillSelectionStore({ userDataPath }).get()).toEqual({ mode: "all" });
  });

  it("falls back to all when the saved mode is unknown", async () => {
    const userDataPath = await createTempUserDataDir();
    await seedSelectionFile(
      userDataPath,
      JSON.stringify({ version: 1, selection: { mode: "some-future-mode", skills: ["paseo"] } }),
    );

    expect(await createSkillSelectionStore({ userDataPath }).get()).toEqual({ mode: "all" });
  });

  it("normalizes a custom selection that was hand-edited on disk", async () => {
    const userDataPath = await createTempUserDataDir();
    await seedSelectionFile(
      userDataPath,
      JSON.stringify({
        version: 1,
        selection: { mode: "custom", skills: ["paseo-loop", 3, "paseo", "paseo"] },
      }),
    );

    expect(await createSkillSelectionStore({ userDataPath }).get()).toEqual({
      mode: "custom",
      skills: ["paseo", "paseo-loop"],
    });
  });

  it("treats a custom selection with no usable skills array as an empty selection", async () => {
    const userDataPath = await createTempUserDataDir();
    await seedSelectionFile(
      userDataPath,
      JSON.stringify({ version: 1, selection: { mode: "custom" } }),
    );

    expect(await createSkillSelectionStore({ userDataPath }).get()).toEqual({
      mode: "custom",
      skills: [],
    });
  });

  it("leaves no temp files behind when saves overlap", async () => {
    const userDataPath = await createTempUserDataDir();
    const store = createSkillSelectionStore({ userDataPath });

    await Promise.all([
      store.set({ mode: "custom", skills: ["paseo"] }),
      store.set({ mode: "all" }),
      store.set({ mode: "custom", skills: ["paseo-loop"] }),
    ]);

    expect(await readdir(userDataPath)).toEqual(["skill-selection.json"]);
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SkillSelection, SkillTargets } from "./operations";
import { createSkillSelectionStore, type SkillSelectionStore } from "./selection-store";
import { createSkillsController, type SkillsController } from "./skills-controller";

interface Harness {
  root: string;
  targets: SkillTargets;
  controller: SkillsController;
}

const BUNDLED_SKILLS = ["paseo", "paseo-advisor", "paseo-loop"];

async function makeHarness(selectionStore?: SkillSelectionStore): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-skills-controller-"));
  const targets: SkillTargets = {
    sourceDir: path.join(root, "bundle"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };
  for (const name of BUNDLED_SKILLS) {
    await mkdir(path.join(targets.sourceDir, name), { recursive: true });
    await writeFile(path.join(targets.sourceDir, name, "SKILL.md"), `${name}-v1`);
  }
  return {
    root,
    targets,
    controller: createSkillsController({
      resolveTargets: () => targets,
      selectionStore:
        selectionStore ?? createSkillSelectionStore({ userDataPath: path.join(root, "user-data") }),
    }),
  };
}

/**
 * The selection store is an injected port, so a store that refuses to persist is
 * a fake adapter rather than a mock of the code under test. It is the only way
 * to reach the "converged, then could not commit" path deterministically.
 */
function createUnwritableSelectionStore(initial: SkillSelection): SkillSelectionStore {
  return {
    get: async () => initial,
    set: async () => {
      throw new Error("selection store is read-only");
    },
  };
}

async function installedSkills(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function installedEverywhere(targets: SkillTargets): Promise<string[][]> {
  return Promise.all([targets.agentsDir, targets.claudeDir, targets.codexDir].map(installedSkills));
}

async function writeUserFile(
  targets: SkillTargets,
  skill: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  for (const dir of [targets.agentsDir, targets.claudeDir, targets.codexDir]) {
    const file = path.join(dir, skill, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
}

async function readUserFile(
  targets: SkillTargets,
  skill: string,
  relativePath: string,
): Promise<Array<string | null>> {
  return Promise.all(
    [targets.agentsDir, targets.claudeDir, targets.codexDir].map((dir) =>
      readFile(path.join(dir, skill, relativePath), "utf8").catch(() => null),
    ),
  );
}

/** Anything the transaction staged and failed to clean up sits beside the skills tree. */
async function backupArtifacts(targets: SkillTargets): Promise<string[][]> {
  return Promise.all(
    [targets.agentsDir, targets.claudeDir, targets.codexDir].map(async (dir) => {
      const entries = await readdir(path.dirname(dir)).catch(() => []);
      return entries.filter((entry) => entry !== path.basename(dir)).sort();
    }),
  );
}

/** Puts a regular file where the agents skills tree goes, so convergence fails with ENOTDIR. */
async function blockAgentsDir(targets: SkillTargets): Promise<void> {
  await rm(targets.agentsDir, { recursive: true, force: true });
  await mkdir(path.dirname(targets.agentsDir), { recursive: true });
  await writeFile(targets.agentsDir, "not a directory");
}

async function isInstalled(targets: SkillTargets, name: string): Promise<boolean> {
  const dirs = [targets.agentsDir, targets.claudeDir, targets.codexDir];
  const present = await Promise.all(
    dirs.map((dir) =>
      access(path.join(dir, name))
        .then(() => true)
        .catch(() => false),
    ),
  );
  return present.every(Boolean);
}

describe("skills controller", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await rm(harness.root, { recursive: true, force: true });
  });

  it("reports one snapshot with catalog, selection, status, and pending work", async () => {
    expect(await harness.controller.status()).toEqual({
      state: "not-installed",
      ops: [
        { kind: "add", name: "paseo" },
        { kind: "add", name: "paseo-advisor" },
        { kind: "add", name: "paseo-loop" },
      ],
      available: BUNDLED_SKILLS,
      installed: [],
      selection: { mode: "all" },
    });
  });

  it("installs every bundled skill while the selection is all", async () => {
    expect(await harness.controller.install()).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: BUNDLED_SKILLS,
      selection: { mode: "all" },
    });
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(true);
  });

  it("saves a custom selection, converges disk, and returns the refreshed snapshot", async () => {
    const snapshot = await harness.controller.save({
      mode: "custom",
      skills: ["paseo-loop", "paseo"],
    });

    expect(snapshot).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: ["paseo", "paseo-loop"],
      selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
    });
    expect(await isInstalled(harness.targets, "paseo")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-loop")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(false);
  });

  it("removes a skill from disk when it is dropped from the selection", async () => {
    await harness.controller.install();

    await harness.controller.save({ mode: "custom", skills: ["paseo"] });

    expect(await isInstalled(harness.targets, "paseo")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(false);
    expect(await isInstalled(harness.targets, "paseo-loop")).toBe(false);
  });

  it("keeps the saved selection after uninstall so a later install restores it", async () => {
    await harness.controller.save({ mode: "custom", skills: ["paseo"] });

    const afterUninstall = await harness.controller.uninstall();
    const afterReinstall = await harness.controller.install();

    expect(afterUninstall).toEqual({
      state: "not-installed",
      ops: [{ kind: "add", name: "paseo" }],
      available: BUNDLED_SKILLS,
      installed: [],
      selection: { mode: "custom", skills: ["paseo"] },
    });
    expect(afterReinstall).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: ["paseo"],
      selection: { mode: "custom", skills: ["paseo"] },
    });
    expect(await isInstalled(harness.targets, "paseo")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-loop")).toBe(false);
  });

  it("treats an empty custom selection as uninstall while keeping the preference", async () => {
    await harness.controller.install();

    const snapshot = await harness.controller.save({
      mode: "custom",
      skills: [],
    });

    expect(snapshot).toEqual({
      state: "not-installed",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: [],
      selection: { mode: "custom", skills: [] },
    });
    expect(await isInstalled(harness.targets, "paseo")).toBe(false);
  });

  it("returns to every bundled skill when the selection goes back to all", async () => {
    await harness.controller.save({ mode: "custom", skills: ["paseo"] });

    const snapshot = await harness.controller.save({ mode: "all" });

    expect(snapshot).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: BUNDLED_SKILLS,
      selection: { mode: "all" },
    });
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(true);
  });

  it("keeps the previous selection when the save fails to reach disk", async () => {
    await harness.controller.save({ mode: "custom", skills: ["paseo"] });
    await blockAgentsDir(harness.targets);

    await expect(harness.controller.save({ mode: "all" })).rejects.toThrow();
    await rm(harness.targets.agentsDir, { force: true });

    expect(await harness.controller.status()).toEqual({
      state: "drift",
      ops: [{ kind: "add", name: "paseo" }],
      available: BUNDLED_SKILLS,
      installed: ["paseo"],
      selection: { mode: "custom", skills: ["paseo"] },
    });
  });

  it("saves no selection at all when the very first save fails", async () => {
    await blockAgentsDir(harness.targets);

    await expect(harness.controller.save({ mode: "custom", skills: ["paseo"] })).rejects.toThrow();
    await rm(harness.targets.agentsDir, { force: true });

    expect(await harness.controller.status()).toEqual({
      state: "not-installed",
      ops: BUNDLED_SKILLS.map((name) => ({ kind: "add", name })),
      available: BUNDLED_SKILLS,
      installed: [],
      selection: { mode: "all" },
    });
  });

  it("restores deleted directories byte for byte when the selection cannot be committed", async () => {
    const store = createUnwritableSelectionStore({
      mode: "custom",
      skills: ["paseo", "paseo-loop"],
    });
    const readOnly = await makeHarness(store);
    await readOnly.controller.install();
    await writeUserFile(readOnly.targets, "paseo-loop", "notes/mine.md", "hand written");

    // Deselects paseo-loop and adds paseo-advisor, then fails to commit.
    await expect(
      readOnly.controller.save({ mode: "custom", skills: ["paseo", "paseo-advisor"] }),
    ).rejects.toThrow("selection store is read-only");

    expect(await readOnly.controller.status()).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: ["paseo", "paseo-loop"],
      selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
    });
    expect(await installedEverywhere(readOnly.targets)).toEqual([
      ["paseo", "paseo-loop"],
      ["paseo", "paseo-loop"],
      ["paseo", "paseo-loop"],
    ]);
    expect(await readUserFile(readOnly.targets, "paseo-loop", "notes/mine.md")).toEqual([
      "hand written",
      "hand written",
      "hand written",
    ]);
    expect(await backupArtifacts(readOnly.targets)).toEqual([[], [], []]);
    await rm(readOnly.root, { recursive: true, force: true });
  });

  it("leaves no backup artifacts behind after a successful save", async () => {
    await harness.controller.save({ mode: "custom", skills: ["paseo"] });

    expect(await backupArtifacts(harness.targets)).toEqual([[], [], []]);
  });

  it("serializes startup convergence with an interactive save", async () => {
    await harness.controller.install();
    // Startup finds drift it wants to repair while the user narrows the
    // selection. Whichever runs first, disk must end up matching what is saved.
    await rm(path.join(harness.targets.claudeDir, "paseo-loop"), {
      recursive: true,
      force: true,
    });

    const [, saved] = await Promise.all([
      harness.controller.autoUpdate(),
      harness.controller.save({ mode: "custom", skills: ["paseo"] }),
    ]);

    expect(saved.selection).toEqual({ mode: "custom", skills: ["paseo"] });
    expect(await installedEverywhere(harness.targets)).toEqual([["paseo"], ["paseo"], ["paseo"]]);
    expect(await harness.controller.status()).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: ["paseo"],
      selection: { mode: "custom", skills: ["paseo"] },
    });
  });

  it("updates a drifted install without touching the saved selection", async () => {
    await harness.controller.save({ mode: "custom", skills: ["paseo"] });
    await writeFile(path.join(harness.targets.agentsDir, "paseo", "SKILL.md"), "stale");

    expect(await harness.controller.update()).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      installed: ["paseo"],
      selection: { mode: "custom", skills: ["paseo"] },
    });
  });
});

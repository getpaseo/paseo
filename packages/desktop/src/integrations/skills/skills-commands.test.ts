import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SkillTargets } from "./operations";
import { createSkillSelectionStore } from "./selection-store";
import { createSkillsCommandHandlers } from "./skills-commands";

interface Harness {
  root: string;
  targets: SkillTargets;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const BUNDLED_SKILLS = ["paseo", "paseo-advisor", "paseo-loop"];

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-skills-commands-"));
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
  const handlers = createSkillsCommandHandlers({
    targets,
    selectionStore: createSkillSelectionStore({ userDataPath: path.join(root, "user-data") }),
  });
  return {
    root,
    targets,
    invoke: async (command, args) => {
      const handler = handlers[command];
      if (!handler) throw new Error(`Unknown desktop command: ${command}`);
      return await handler(args);
    },
  };
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

describe("skills desktop commands", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await rm(harness.root, { recursive: true, force: true });
  });

  it("reports one snapshot with catalog, selection, status, and pending work", async () => {
    expect(await harness.invoke("get_skills_status")).toEqual({
      state: "not-installed",
      ops: [
        { kind: "add", name: "paseo" },
        { kind: "add", name: "paseo-advisor" },
        { kind: "add", name: "paseo-loop" },
      ],
      available: BUNDLED_SKILLS,
      selection: { mode: "all" },
    });
  });

  it("installs every bundled skill while the selection is all", async () => {
    expect(await harness.invoke("install_skills")).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      selection: { mode: "all" },
    });
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(true);
  });

  it("saves a custom selection, converges disk, and returns the refreshed snapshot", async () => {
    const snapshot = await harness.invoke("save_skills_selection", {
      mode: "custom",
      skills: ["paseo-loop", "paseo"],
    });

    expect(snapshot).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      selection: { mode: "custom", skills: ["paseo", "paseo-loop"] },
    });
    expect(await isInstalled(harness.targets, "paseo")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-loop")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(false);
  });

  it("removes a skill from disk when it is dropped from the selection", async () => {
    await harness.invoke("install_skills");

    await harness.invoke("save_skills_selection", { mode: "custom", skills: ["paseo"] });

    expect(await isInstalled(harness.targets, "paseo")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(false);
    expect(await isInstalled(harness.targets, "paseo-loop")).toBe(false);
  });

  it("keeps the saved selection after uninstall so a later install restores it", async () => {
    await harness.invoke("save_skills_selection", { mode: "custom", skills: ["paseo"] });

    const afterUninstall = await harness.invoke("uninstall_skills");
    const afterReinstall = await harness.invoke("install_skills");

    expect(afterUninstall).toEqual({
      state: "not-installed",
      ops: [{ kind: "add", name: "paseo" }],
      available: BUNDLED_SKILLS,
      selection: { mode: "custom", skills: ["paseo"] },
    });
    expect(afterReinstall).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      selection: { mode: "custom", skills: ["paseo"] },
    });
    expect(await isInstalled(harness.targets, "paseo")).toBe(true);
    expect(await isInstalled(harness.targets, "paseo-loop")).toBe(false);
  });

  it("treats an empty custom selection as uninstall while keeping the preference", async () => {
    await harness.invoke("install_skills");

    const snapshot = await harness.invoke("save_skills_selection", {
      mode: "custom",
      skills: [],
    });

    expect(snapshot).toEqual({
      state: "not-installed",
      ops: [],
      available: BUNDLED_SKILLS,
      selection: { mode: "custom", skills: [] },
    });
    expect(await isInstalled(harness.targets, "paseo")).toBe(false);
  });

  it("returns to every bundled skill when the selection goes back to all", async () => {
    await harness.invoke("save_skills_selection", { mode: "custom", skills: ["paseo"] });

    const snapshot = await harness.invoke("save_skills_selection", { mode: "all" });

    expect(snapshot).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      selection: { mode: "all" },
    });
    expect(await isInstalled(harness.targets, "paseo-advisor")).toBe(true);
  });

  it("keeps the previous selection when the save fails to reach disk", async () => {
    await harness.invoke("save_skills_selection", { mode: "custom", skills: ["paseo"] });
    await blockAgentsDir(harness.targets);

    await expect(harness.invoke("save_skills_selection", { mode: "all" })).rejects.toThrow();
    await rm(harness.targets.agentsDir, { force: true });

    expect(await harness.invoke("get_skills_status")).toEqual({
      state: "drift",
      ops: [{ kind: "add", name: "paseo" }],
      available: BUNDLED_SKILLS,
      selection: { mode: "custom", skills: ["paseo"] },
    });
  });

  it("saves no selection at all when the very first save fails", async () => {
    await blockAgentsDir(harness.targets);

    await expect(
      harness.invoke("save_skills_selection", { mode: "custom", skills: ["paseo"] }),
    ).rejects.toThrow();
    await rm(harness.targets.agentsDir, { force: true });

    expect(await harness.invoke("get_skills_status")).toEqual({
      state: "not-installed",
      ops: BUNDLED_SKILLS.map((name) => ({ kind: "add", name })),
      available: BUNDLED_SKILLS,
      selection: { mode: "all" },
    });
  });

  it("updates a drifted install without touching the saved selection", async () => {
    await harness.invoke("save_skills_selection", { mode: "custom", skills: ["paseo"] });
    await writeFile(path.join(harness.targets.agentsDir, "paseo", "SKILL.md"), "stale");

    expect(await harness.invoke("update_skills")).toEqual({
      state: "up-to-date",
      ops: [],
      available: BUNDLED_SKILLS,
      selection: { mode: "custom", skills: ["paseo"] },
    });
  });
});

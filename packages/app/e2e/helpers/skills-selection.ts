import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { openSettings } from "./app";
import { openSettingsSection } from "./settings";
// The desktop skills module is the real command surface: the same handlers the
// Electron main process registers, running against a temp bundle and temp user
// data. Nothing about persistence or convergence is simulated in the browser.
import type { SkillTargets } from "../../../desktop/src/integrations/skills/operations.js";
import { createSkillSelectionStore } from "../../../desktop/src/integrations/skills/selection-store.js";
import { createSkillsCommandHandlers } from "../../../desktop/src/integrations/skills/skills-commands.js";

const SKILL_COMMANDS = [
  "get_skills_status",
  "install_skills",
  "update_skills",
  "uninstall_skills",
  "save_skills_selection",
] as const;

declare global {
  interface Window {
    __paseoSkillsInvoke?: (
      command: string,
      args: Record<string, unknown> | null,
    ) => Promise<unknown>;
  }
}

export interface SkillsSandbox {
  targets: SkillTargets;
  userDataPath: string;
  bundledSkills: string[];
  cleanup: () => Promise<void>;
}

export interface SkillsSandboxOptions {
  bundledSkills?: string[];
  /**
   * Puts a regular file where the `.agents` skills tree has to go, so the real
   * convergence fails with ENOTDIR instead of a stubbed rejection.
   */
  blockAgentsDir?: boolean;
}

export async function createSkillsSandbox(
  options: SkillsSandboxOptions = {},
): Promise<SkillsSandbox> {
  const bundledSkills = options.bundledSkills ?? ["paseo", "paseo-advisor", "paseo-loop"];
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-e2e-skills-"));
  const targets: SkillTargets = {
    sourceDir: path.join(root, "bundle"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };

  for (const name of bundledSkills) {
    await mkdir(path.join(targets.sourceDir, name), { recursive: true });
    await writeFile(path.join(targets.sourceDir, name, "SKILL.md"), `# ${name}\n`, "utf8");
  }

  if (options.blockAgentsDir) {
    await mkdir(path.dirname(targets.agentsDir), { recursive: true });
    await writeFile(targets.agentsDir, "not a directory", "utf8");
  }

  return {
    targets,
    userDataPath: path.join(root, "user-data"),
    bundledSkills,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Routes the skills desktop commands to the real handlers in Node, leaving every
 * other command on the injected desktop bridge. Call after `injectDesktopBridge`
 * and before navigation.
 */
export async function serveRealSkillsCommands(page: Page, sandbox: SkillsSandbox): Promise<void> {
  const handlers = createSkillsCommandHandlers({
    resolveTargets: () => sandbox.targets,
    selectionStore: createSkillSelectionStore({ userDataPath: sandbox.userDataPath }),
  });

  await page.exposeFunction(
    "__paseoSkillsInvoke",
    async (command: string, args: Record<string, unknown> | null) => {
      const handler = handlers[command];
      if (!handler) throw new Error(`Unknown skills command: ${command}`);
      return await handler(args ?? undefined);
    },
  );

  await page.addInitScript((commands: readonly string[]) => {
    const bridge = (window as unknown as { paseoDesktop?: { invoke: unknown } }).paseoDesktop;
    if (!bridge) throw new Error("Desktop bridge must be injected before the skills bridge.");
    const skillCommands = new Set(commands);
    const inner = bridge.invoke as (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    bridge.invoke = (command: string, args?: Record<string, unknown>) =>
      skillCommands.has(command)
        ? window.__paseoSkillsInvoke!(command, args ?? null)
        : inner(command, args);
  }, SKILL_COMMANDS);
}

export async function openSkillsIntegrations(page: Page): Promise<void> {
  await openSettings(page);
  await openSettingsSection(page, "integrations");
  await expect(page.getByText("Orchestration skills", { exact: true })).toBeVisible();
}

export async function openSkillSelection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Choose skills", exact: true }).click();
  await expectSkillSelectionOpen(page);
}

export async function expectSkillSelectionOpen(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "All skills", exact: true })).toBeVisible();
}

export async function expectSkillSelectionClosed(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "All skills", exact: true })).toHaveCount(0);
}

export async function chooseAllSkills(page: Page): Promise<void> {
  const allSkills = page.getByRole("switch", { name: "All skills", exact: true });
  await expect(allSkills).not.toBeChecked();
  await allSkills.click();
  await expect(allSkills).toBeChecked();
}

export async function chooseCustomSkills(page: Page, skills: string[]): Promise<void> {
  const allSkills = page.getByRole("switch", { name: "All skills", exact: true });
  await expect(allSkills).toBeChecked();
  await allSkills.click();
  await expect(allSkills).not.toBeChecked();

  const keep = new Set(skills);
  for (const name of await listSkillChoices(page)) {
    if (keep.has(name)) continue;
    await page.getByRole("checkbox", { name, exact: true }).click();
  }
  await expectSkillChoices(page, skills);
}

export async function toggleSkill(page: Page, name: string): Promise<void> {
  await page.getByRole("checkbox", { name, exact: true }).click();
}

export async function saveSkillSelection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

export async function cancelSkillSelection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expectSkillSelectionClosed(page);
}

export async function listSkillChoices(page: Page): Promise<string[]> {
  const rows = page.getByRole("checkbox");
  const names = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? ""),
  );
  return names.filter((name) => name.length > 0);
}

/** Asserts exactly which skills are checked in the open sheet. */
export async function expectSkillChoices(page: Page, skills: string[]): Promise<void> {
  const expected = new Set(skills);
  for (const name of await listSkillChoices(page)) {
    const choice = page.getByRole("checkbox", { name, exact: true });
    if (expected.has(name)) {
      await expect(choice).toBeChecked();
      continue;
    }
    await expect(choice).not.toBeChecked();
  }
}

/** Reopens the saved selection and asserts what the user sees, then closes it. */
export async function expectSelectedSkills(page: Page, skills: string[]): Promise<void> {
  await openSkillSelection(page);
  await expect(page.getByRole("switch", { name: "All skills", exact: true })).not.toBeChecked();
  await expectSkillChoices(page, skills);
  await cancelSkillSelection(page);
}

export async function expectAllSkillsSelected(page: Page): Promise<void> {
  await openSkillSelection(page);
  const allSkills = page.getByRole("switch", { name: "All skills", exact: true });
  await expect(allSkills).toBeChecked();
  await expectSkillChoices(page, await listSkillChoices(page));
  await cancelSkillSelection(page);
}

export async function expectSaveErrorKeepsSheetOpen(page: Page): Promise<void> {
  await expect(page.getByText("Could not save your skill selection.", { exact: true })).toBeVisible(
    { timeout: 15_000 },
  );
  await expectSkillSelectionOpen(page);
}

export async function expectSkillsInstalled(
  sandbox: SkillsSandbox,
  skills: string[],
): Promise<void> {
  const dirs = [
    sandbox.targets.agentsDir,
    sandbox.targets.claudeDir,
    sandbox.targets.codexDir,
  ] as const;
  for (const dir of dirs) {
    await expect
      .poll(async () => readInstalledSkills(dir), { timeout: 15_000 })
      .toEqual([...skills].sort());
  }
}

async function readInstalledSkills(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

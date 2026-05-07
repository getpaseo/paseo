import { promises as fs } from "node:fs";
import path from "node:path";
import log from "electron-log/main";
import {
  diffSkills,
  hashBundle,
  readManifest,
  type SkillManifest,
  type SkillOp,
  writeManifest,
} from "./manifest.js";
import {
  getAgentsSkillsDir,
  getBundledSkillsDir,
  getClaudeSkillsDir,
  getCodexSkillsDir,
} from "./paths.js";
import { removeSkill, syncSkills } from "./sync.js";

export type SkillsState = "fresh" | "up-to-date" | "drift";

export interface SkillsStatus {
  state: SkillsState;
  ops: SkillOp[];
}

export interface SkillTargets {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
}

const SKILL_NAMES = [
  "paseo",
  "paseo-advisor",
  "paseo-committee",
  "paseo-epic",
  "paseo-handoff",
  "paseo-loop",
  "paseo-orchestrate",
];

function resolveSkillTargets(): SkillTargets {
  return {
    sourceDir: getBundledSkillsDir(),
    agentsDir: getAgentsSkillsDir(),
    claudeDir: getClaudeSkillsDir(),
    codexDir: getCodexSkillsDir(),
  };
}

async function agentsDirHasSkillContent(agentsDir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return false;
  }
  return entries.some((name) => !name.startsWith("."));
}

export async function migrateLegacyInstallIfNeeded(
  targets?: SkillTargets,
): Promise<{ migrated: boolean; skillCount: number }> {
  const t = targets ?? resolveSkillTargets();
  const existingManifest = await readManifest(t.agentsDir);
  if (existingManifest !== null) {
    return { migrated: false, skillCount: 0 };
  }

  const existing: string[] = [];
  for (const name of SKILL_NAMES) {
    const stat = await fs.stat(path.join(t.agentsDir, name)).catch(() => null);
    if (stat?.isDirectory()) existing.push(name);
  }
  if (existing.length === 0) {
    return { migrated: false, skillCount: 0 };
  }

  const synthesized = await hashBundle(t.agentsDir, existing);
  await writeManifest(t.agentsDir, { version: 1, skills: synthesized });
  log.info("[integrations] migrated legacy skills install", {
    skillCount: synthesized.length,
  });
  return { migrated: true, skillCount: synthesized.length };
}

export async function getSkillsStatus(targets?: SkillTargets): Promise<SkillsStatus> {
  const t = targets ?? resolveSkillTargets();
  await migrateLegacyInstallIfNeeded(t);

  const bundle = await hashBundle(t.sourceDir, SKILL_NAMES);
  const manifest = await readManifest(t.agentsDir);
  const ops = diffSkills(bundle, manifest);

  if (manifest === null) {
    const hasContent = await agentsDirHasSkillContent(t.agentsDir);
    return { state: hasContent ? "drift" : "fresh", ops };
  }

  return { state: ops.length === 0 ? "up-to-date" : "drift", ops };
}

export async function installSkills(targets?: SkillTargets): Promise<SkillsStatus> {
  const t = targets ?? resolveSkillTargets();
  await migrateLegacyInstallIfNeeded(t);
  log.info("[integrations] installSkills", t);

  const result = await syncSkills({
    ...t,
    skillNames: SKILL_NAMES,
    onSkillError: (skillName, error) => {
      log.warn("[integrations] skill install failed", { skillName, error });
    },
  });
  log.info("[integrations] installSkills done", result);

  const bundle = await hashBundle(t.sourceDir, SKILL_NAMES);
  const manifest: SkillManifest = { version: 1, skills: bundle };
  await writeManifest(t.agentsDir, manifest);

  return getSkillsStatus(t);
}

export async function updateSkills(targets?: SkillTargets): Promise<SkillsStatus> {
  const t = targets ?? resolveSkillTargets();
  await migrateLegacyInstallIfNeeded(t);
  const bundle = await hashBundle(t.sourceDir, SKILL_NAMES);
  const manifest = await readManifest(t.agentsDir);
  const ops = diffSkills(bundle, manifest);

  const writes = ops.filter((op) => op.kind === "add" || op.kind === "update").map((op) => op.name);
  if (writes.length > 0) {
    const result = await syncSkills({
      ...t,
      skillNames: writes,
      onSkillError: (skillName, error) => {
        log.warn("[integrations] skill update failed", { skillName, error });
      },
    });
    log.info("[integrations] updateSkills writes done", result);
  }

  for (const op of ops) {
    if (op.kind !== "delete") continue;
    try {
      await removeSkill(op.name, {
        agentsDir: t.agentsDir,
        claudeDir: t.claudeDir,
        codexDir: t.codexDir,
      });
    } catch (error) {
      log.warn("[integrations] skill delete failed", { skillName: op.name, error });
    }
  }

  await writeManifest(t.agentsDir, { version: 1, skills: bundle });
  return getSkillsStatus(t);
}

export async function uninstallSkills(targets?: SkillTargets): Promise<SkillsStatus> {
  const t = targets ?? resolveSkillTargets();
  await migrateLegacyInstallIfNeeded(t);
  const manifest = await readManifest(t.agentsDir);

  if (manifest) {
    for (const skill of manifest.skills) {
      try {
        await removeSkill(skill.name, {
          agentsDir: t.agentsDir,
          claudeDir: t.claudeDir,
          codexDir: t.codexDir,
        });
      } catch (error) {
        log.warn("[integrations] skill uninstall failed", { skillName: skill.name, error });
      }
    }
  }

  await fs.rm(path.join(t.agentsDir, ".paseo-manifest.json"), { force: true });
  return getSkillsStatus(t);
}

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getAgentsSkillsDir,
  getBundledSkillsDir,
  getClaudeSkillsDir,
  getCodexSkillsDir,
} from "./paths.js";
import { listFilesRecursive, removeSkill, syncSkills } from "./sync.js";

export type SkillsState = "not-installed" | "up-to-date" | "drift";

export type SkillOp =
  | { kind: "add"; name: string }
  | { kind: "update"; name: string }
  | { kind: "delete"; name: string };

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

export const PASEO_SKILL_NAMES = [
  "paseo",
  "paseo-advisor",
  "paseo-chat",
  "paseo-committee",
  "paseo-epic",
  "paseo-handoff",
  "paseo-loop",
  "paseo-orchestrate",
  "paseo-orchestrator",
] as const;

type SkillFiles = Map<string, string>;

function resolveSkillTargets(): SkillTargets {
  return {
    sourceDir: getBundledSkillsDir(),
    agentsDir: getAgentsSkillsDir(),
    claudeDir: getClaudeSkillsDir(),
    codexDir: getCodexSkillsDir(),
  };
}

async function hashSkillDir(skillDir: string): Promise<SkillFiles | null> {
  const stat = await fs.stat(skillDir).catch(() => null);
  if (!stat?.isDirectory()) return null;

  const rels = await listFilesRecursive(skillDir);
  const files: SkillFiles = new Map();
  for (const rel of rels) {
    const buf = await fs.readFile(path.join(skillDir, rel));
    const sha = createHash("sha256").update(buf).digest("hex");
    files.set(toPosix(rel), sha);
  }
  return files;
}

async function hashSkills(rootDir: string): Promise<Map<string, SkillFiles>> {
  const out = new Map<string, SkillFiles>();
  for (const name of PASEO_SKILL_NAMES) {
    const files = await hashSkillDir(path.join(rootDir, name));
    if (files !== null) out.set(name, files);
  }
  return out;
}

function diff(bundle: Map<string, SkillFiles>, disk: Map<string, SkillFiles>): SkillOp[] {
  const ops: SkillOp[] = [];
  for (const name of PASEO_SKILL_NAMES) {
    const b = bundle.get(name);
    const d = disk.get(name);
    if (b && !d) ops.push({ kind: "add", name });
    else if (b && d && !filesEqual(b, d)) ops.push({ kind: "update", name });
    else if (!b && d) ops.push({ kind: "delete", name });
  }
  ops.sort((a, b) => compareStrings(a.name, b.name));
  return ops;
}

function filesEqual(a: SkillFiles, b: SkillFiles): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, sha] of a) {
    if (b.get(rel) !== sha) return false;
  }
  return true;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export async function getSkillsStatus(targets?: SkillTargets): Promise<SkillsStatus> {
  const t = targets ?? resolveSkillTargets();
  const [bundle, disk] = await Promise.all([hashSkills(t.sourceDir), hashSkills(t.agentsDir)]);
  const ops = diff(bundle, disk);

  if (disk.size === 0) return { state: "not-installed", ops };
  if (ops.length === 0) return { state: "up-to-date", ops };
  return { state: "drift", ops };
}

async function applySkills(targets: SkillTargets): Promise<SkillsStatus> {
  const status = await getSkillsStatus(targets);

  const writes = status.ops
    .filter((op) => op.kind === "add" || op.kind === "update")
    .map((op) => op.name);
  if (writes.length > 0) {
    await syncSkills({
      sourceDir: targets.sourceDir,
      agentsDir: targets.agentsDir,
      claudeDir: targets.claudeDir,
      codexDir: targets.codexDir,
      skillNames: writes,
    });
  }

  for (const op of status.ops) {
    if (op.kind !== "delete") continue;
    await removeSkill(op.name, {
      agentsDir: targets.agentsDir,
      claudeDir: targets.claudeDir,
      codexDir: targets.codexDir,
    });
  }

  return getSkillsStatus(targets);
}

export async function installSkills(targets?: SkillTargets): Promise<SkillsStatus> {
  return applySkills(targets ?? resolveSkillTargets());
}

export async function updateSkills(targets?: SkillTargets): Promise<SkillsStatus> {
  return applySkills(targets ?? resolveSkillTargets());
}

export async function uninstallSkills(targets?: SkillTargets): Promise<SkillsStatus> {
  const t = targets ?? resolveSkillTargets();
  for (const name of PASEO_SKILL_NAMES) {
    await removeSkill(name, {
      agentsDir: t.agentsDir,
      claudeDir: t.claudeDir,
      codexDir: t.codexDir,
    });
  }
  return getSkillsStatus(t);
}

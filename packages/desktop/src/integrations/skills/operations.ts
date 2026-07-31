import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFilesRecursive, removeSkill, syncSkills } from "./sync.js";

export type SkillsState = "not-installed" | "up-to-date" | "drift";

export type SkillOp =
  | { kind: "add"; name: string }
  | { kind: "update"; name: string }
  | { kind: "delete"; name: string };

/** What the user asked to have installed. `all` follows the bundle as it grows. */
export type SkillSelection = { mode: "all" } | { mode: "custom"; skills: readonly string[] };

export interface SkillsStatus {
  state: SkillsState;
  ops: SkillOp[];
  /** Every skill the bundle currently ships, sorted. The selectable catalog. */
  available: string[];
  /**
   * Managed skills with a directory in at least one agent home, sorted. An `add`
   * op means "missing from at least one target", so it cannot answer whether
   * there is anything on disk to delete — this can.
   */
  installed: string[];
}

export interface SkillTargets {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
}

// Names the bundle used to ship. They are never selectable, but every scan still
// covers them so an older install's copies get cleaned up.
export const LEGACY_SKILL_NAMES = [
  "paseo-chat",
  "paseo-epic",
  "paseo-orchestrate",
  "paseo-orchestrator",
] as const;

type SkillFiles = Map<string, string>;
type TargetSkills = Map<string, SkillFiles>;

/**
 * The bundle directory is the catalog. Reading it instead of a hardcoded list is
 * what makes `all` pick up skills added in a later release with no code change.
 */
async function listBundledSkills(sourceDir: string): Promise<string[]> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);
}

/** Every name Paseo owns on disk: what it ships now plus what it used to ship. */
function managedSkillNames(available: readonly string[]): string[] {
  return [...new Set([...available, ...LEGACY_SKILL_NAMES])].sort(compareStrings);
}

function resolveDesiredSkills(
  selection: SkillSelection,
  available: readonly string[],
): Set<string> {
  if (selection.mode === "all") return new Set(available);
  const chosen = new Set(selection.skills);
  return new Set(available.filter((name) => chosen.has(name)));
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

async function hashSkills(rootDir: string, names: readonly string[]): Promise<TargetSkills> {
  const out: TargetSkills = new Map();
  for (const name of names) {
    const files = await hashSkillDir(path.join(rootDir, name));
    if (files !== null) out.set(name, files);
  }
  return out;
}

function diff(
  bundle: TargetSkills,
  disks: readonly TargetSkills[],
  names: readonly string[],
  desired: ReadonlySet<string>,
): SkillOp[] {
  const ops: SkillOp[] = [];
  for (const name of names) {
    const b = desired.has(name) ? bundle.get(name) : undefined;
    const targetFiles = disks.map((disk) => disk.get(name));
    const installedTargets = targetFiles.filter(
      (files): files is SkillFiles => files !== undefined,
    );
    if (b) {
      const missingTargets = installedTargets.length < disks.length;
      const changedTargets = installedTargets.some((files) => !bundleFilesMatch(b, files));
      if (missingTargets) ops.push({ kind: "add", name });
      else if (changedTargets) ops.push({ kind: "update", name });
    } else if (installedTargets.length > 0) {
      ops.push({ kind: "delete", name });
    }
  }
  ops.sort((a, b) => compareStrings(a.name, b.name));
  return ops;
}

function hasInstalledPaseoSkill(disks: readonly TargetSkills[]): boolean {
  return disks.some((disk) => disk.size > 0);
}

function installedSkillNames(disks: readonly TargetSkills[], names: readonly string[]): string[] {
  return names.filter((name) => disks.some((disk) => disk.has(name)));
}

function bundleFilesMatch(bundle: SkillFiles, disk: SkillFiles): boolean {
  for (const [rel, sha] of bundle) {
    if (disk.get(rel) !== sha) return false;
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

export async function getSkillsStatus(
  targets: SkillTargets,
  selection: SkillSelection,
): Promise<SkillsStatus> {
  const available = await listBundledSkills(targets.sourceDir);
  const names = managedSkillNames(available);
  const [bundle, agentsDisk, claudeDisk, codexDisk] = await Promise.all([
    hashSkills(targets.sourceDir, available),
    hashSkills(targets.agentsDir, names),
    hashSkills(targets.claudeDir, names),
    hashSkills(targets.codexDir, names),
  ]);
  const disks = [agentsDisk, claudeDisk, codexDisk];
  const ops = diff(bundle, disks, names, resolveDesiredSkills(selection, available));
  const installed = installedSkillNames(disks, names);

  if (!hasInstalledPaseoSkill(disks)) return { state: "not-installed", ops, available, installed };
  if (ops.length === 0) return { state: "up-to-date", ops, available, installed };
  return { state: "drift", ops, available, installed };
}

async function applySkills(
  targets: SkillTargets,
  selection: SkillSelection,
  initialStatus?: SkillsStatus,
): Promise<SkillsStatus> {
  const status = initialStatus ?? (await getSkillsStatus(targets, selection));

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

  return getSkillsStatus(targets, selection);
}

export async function installSkills(
  targets: SkillTargets,
  selection: SkillSelection,
): Promise<SkillsStatus> {
  return applySkills(targets, selection);
}

export async function updateSkills(
  targets: SkillTargets,
  selection: SkillSelection,
): Promise<SkillsStatus> {
  return applySkills(targets, selection);
}

export async function autoUpdateInstalledSkills(
  targets: SkillTargets,
  selection: SkillSelection,
): Promise<SkillsStatus> {
  const status = await getSkillsStatus(targets, selection);
  if (status.state !== "drift") return status;
  return applySkills(targets, selection, status);
}

export async function uninstallSkills(
  targets: SkillTargets,
  selection: SkillSelection,
): Promise<SkillsStatus> {
  const available = await listBundledSkills(targets.sourceDir);
  for (const name of managedSkillNames(available)) {
    await removeSkill(name, {
      agentsDir: targets.agentsDir,
      claudeDir: targets.claudeDir,
      codexDir: targets.codexDir,
    });
  }
  return getSkillsStatus(targets, selection);
}

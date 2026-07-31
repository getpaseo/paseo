import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { listManagedSkillNames, type SkillSelection, type SkillTargets } from "./operations.js";

export interface SkillsTransaction {
  /** Convergence stuck. Drop the staged copies. */
  commit(): Promise<void>;
  /** Put every captured directory back exactly as it was, then drop the staging. */
  rollback(): Promise<void>;
}

/**
 * Written before anything is touched and updated once capture finishes. A
 * directory without a readable one of these is not ours and is never deleted —
 * the prefix alone is a guess, and guessing here deletes someone's files.
 */
interface TransactionManifest {
  owner: typeof MANIFEST_OWNER;
  version: 1;
  /** `capturing` means convergence never started, so there is nothing to undo. */
  phase: "capturing" | "converging";
  previousSelection: SkillSelection;
  nextSelection: SkillSelection;
  entries: CapturedDirectory[];
}

interface CapturedDirectory {
  livePath: string;
  /** Relative to the transaction directory. Null when nothing was there. */
  backupPath: string | null;
}

const MANIFEST_OWNER = "paseo-skills-transaction";
const MANIFEST_FILENAME = "transaction.json";
const TRANSACTION_PREFIX = ".paseo-skills-transaction-";
const BACKUP_DIRNAME = "backup";

async function isDirectory(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null);
  return info?.isDirectory() === true;
}

function isSkillSelection(value: unknown): value is SkillSelection {
  if (typeof value !== "object" || value === null) return false;
  const selection = value as Partial<SkillSelection>;
  if (selection.mode === "all") return true;
  return (
    selection.mode === "custom" &&
    Array.isArray(selection.skills) &&
    selection.skills.every((name) => typeof name === "string")
  );
}

async function readManifest(transactionDir: string): Promise<TransactionManifest | null> {
  const raw = await readFile(path.join(transactionDir, MANIFEST_FILENAME), "utf8").catch(
    () => null,
  );
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const manifest = parsed as Partial<TransactionManifest>;
  if (manifest.owner !== MANIFEST_OWNER || manifest.version !== 1) return null;
  if (manifest.phase !== "capturing" && manifest.phase !== "converging") return null;
  if (!isSkillSelection(manifest.previousSelection) || !isSkillSelection(manifest.nextSelection)) {
    return null;
  }
  if (!Array.isArray(manifest.entries)) return null;
  const entries = manifest.entries.filter(
    (entry): entry is CapturedDirectory =>
      typeof entry?.livePath === "string" &&
      (entry.backupPath === null || typeof entry.backupPath === "string"),
  );
  return {
    owner: MANIFEST_OWNER,
    version: 1,
    phase: manifest.phase,
    previousSelection: manifest.previousSelection,
    nextSelection: manifest.nextSelection,
    entries,
  };
}

async function writeManifest(transactionDir: string, manifest: TransactionManifest): Promise<void> {
  await writeFile(
    path.join(transactionDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function selectionsEqual(left: SkillSelection, right: SkillSelection): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "all" || right.mode === "all") return true;
  return (
    left.skills.length === right.skills.length &&
    left.skills.every((name, index) => name === right.skills[index])
  );
}

async function validateEntries(
  targets: SkillTargets,
  transactionDir: string,
  entries: CapturedDirectory[],
): Promise<boolean> {
  const names = new Set(await listManagedSkillNames(targets.sourceDir));
  const roots = [targets.agentsDir, targets.claudeDir, targets.codexDir];
  return entries.every((entry) => {
    const rootIndex = roots.findIndex((root) => path.dirname(entry.livePath) === root);
    if (rootIndex === -1) return false;
    const name = path.basename(entry.livePath);
    if (!names.has(name)) return false;
    if (entry.backupPath === null) return true;
    const expected = path.join(BACKUP_DIRNAME, String(rootIndex), name);
    return (
      entry.backupPath === expected &&
      path
        .resolve(transactionDir, entry.backupPath)
        .startsWith(`${path.resolve(transactionDir)}${path.sep}`)
    );
  });
}

async function restore(transactionDir: string, manifest: TransactionManifest): Promise<void> {
  // Nothing was converged yet, so the live tree is already the pre-save state.
  if (manifest.phase === "capturing") return;
  for (const entry of manifest.entries) {
    await rm(entry.livePath, { recursive: true, force: true });
    if (entry.backupPath === null) continue;
    const backup = path.join(transactionDir, entry.backupPath);
    if (!(await isDirectory(backup))) {
      throw new Error(`Skills transaction backup is missing: ${backup}`);
    }
    await mkdir(path.dirname(entry.livePath), { recursive: true });
    await cp(backup, entry.livePath, { recursive: true });
  }
}

function transactionParents(targets: SkillTargets): string[] {
  return [
    ...new Set(
      [targets.agentsDir, targets.claudeDir, targets.codexDir].map((root) => path.dirname(root)),
    ),
  ];
}

/**
 * Finishes what an interrupted save started. A transaction directory only exists
 * while a save is mid-flight, so finding one means the process died between
 * mutating the directories and committing the selection — the staged copies are
 * the only place the user's files still exist. Restore them, then drop the
 * transaction. Anything without our manifest is left where it is.
 */
export async function recoverInterruptedSkillTransactions(
  targets: SkillTargets,
  committedSelection: SkillSelection,
): Promise<void> {
  for (const parent of transactionParents(targets)) {
    const entries = await readdir(parent).catch(() => []);
    for (const entry of entries) {
      if (!entry.startsWith(TRANSACTION_PREFIX)) continue;
      const transactionDir = path.join(parent, entry);
      const manifest = await readManifest(transactionDir);
      if (!manifest) continue;
      if (!(await validateEntries(targets, transactionDir, manifest.entries))) continue;
      if (selectionsEqual(committedSelection, manifest.nextSelection)) {
        await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (!selectionsEqual(committedSelection, manifest.previousSelection)) {
        throw new Error(
          `Cannot safely recover interrupted skills transaction at ${transactionDir}`,
        );
      }
      await restore(transactionDir, manifest);
      await rm(transactionDir, { recursive: true, force: true });
    }
  }
}

/**
 * Captures the managed skill directories so a failed save can put the machine
 * back exactly as it was — including files the user added inside them, which
 * re-running an install cannot reconstruct.
 */
export async function beginSkillsTransaction(
  targets: SkillTargets,
  previousSelection: SkillSelection,
  nextSelection: SkillSelection,
): Promise<SkillsTransaction> {
  const names = await listManagedSkillNames(targets.sourceDir);
  const roots = [targets.agentsDir, targets.claudeDir, targets.codexDir];
  // Staged next to the skills tree rather than inside it: same filesystem, so a
  // restore is a local copy, and never a directory a skill scan walks into.
  const transactionDir = path.join(path.dirname(roots[0]!), `${TRANSACTION_PREFIX}${randomUUID()}`);
  const entries: CapturedDirectory[] = [];

  async function discard(): Promise<void> {
    await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
  }

  await mkdir(transactionDir, { recursive: true });
  await writeManifest(transactionDir, {
    owner: MANIFEST_OWNER,
    version: 1,
    phase: "capturing",
    previousSelection,
    nextSelection,
    entries: [],
  });

  try {
    for (const [rootIndex, root] of roots.entries()) {
      for (const name of names) {
        const livePath = path.join(root, name);
        if (!(await isDirectory(livePath))) {
          entries.push({ livePath, backupPath: null });
          continue;
        }
        const backupPath = path.join(BACKUP_DIRNAME, String(rootIndex), name);
        await cp(livePath, path.join(transactionDir, backupPath), { recursive: true });
        entries.push({ livePath, backupPath });
      }
    }
    await writeManifest(transactionDir, {
      owner: MANIFEST_OWNER,
      version: 1,
      phase: "converging",
      previousSelection,
      nextSelection,
      entries,
    });
  } catch (error) {
    // Nothing has been converged yet, so failing to stage means failing the save
    // before it touches anything.
    await discard();
    throw error;
  }

  return {
    commit: discard,
    async rollback(): Promise<void> {
      await restore(transactionDir, {
        owner: MANIFEST_OWNER,
        version: 1,
        phase: "converging",
        previousSelection,
        nextSelection,
        entries,
      });
      await discard();
    },
  };
}

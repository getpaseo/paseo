import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { listManagedSkillNames, type SkillTargets } from "./operations.js";

export interface SkillsTransaction {
  /** Convergence stuck. Drop the staged copies. */
  commit(): Promise<void>;
  /** Put every captured directory back exactly as it was, then drop the staging. */
  rollback(): Promise<void>;
}

interface CapturedDirectory {
  livePath: string;
  /** Null when nothing was there, so rolling back means deleting whatever appeared. */
  backupPath: string | null;
}

// Staged next to the skills tree rather than inside it: same filesystem, so a
// restore is a local copy, and never a directory a skill scan walks into.
const STAGING_PREFIX = ".paseo-skills-backup-";

async function isDirectory(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null);
  return info?.isDirectory() === true;
}

/**
 * Captures the managed skill directories so a failed save can put the machine
 * back exactly as it was — including files the user added inside them, which
 * re-running an install cannot reconstruct.
 */
export async function beginSkillsTransaction(targets: SkillTargets): Promise<SkillsTransaction> {
  const names = await listManagedSkillNames(targets.sourceDir);
  const roots = [targets.agentsDir, targets.claudeDir, targets.codexDir];
  const stagingByRoot = new Map<string, string>();
  const captured: CapturedDirectory[] = [];

  async function discard(): Promise<void> {
    for (const staging of stagingByRoot.values()) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    stagingByRoot.clear();
  }

  async function stagingFor(root: string): Promise<string> {
    const existing = stagingByRoot.get(root);
    if (existing) return existing;
    const staging = path.join(path.dirname(root), `${STAGING_PREFIX}${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    stagingByRoot.set(root, staging);
    return staging;
  }

  try {
    for (const root of roots) {
      for (const name of names) {
        const livePath = path.join(root, name);
        if (!(await isDirectory(livePath))) {
          captured.push({ livePath, backupPath: null });
          continue;
        }
        const backupPath = path.join(await stagingFor(root), name);
        await cp(livePath, backupPath, { recursive: true });
        captured.push({ livePath, backupPath });
      }
    }
  } catch (error) {
    // Nothing has been converged yet, so failing to stage means failing the save
    // before it touches anything.
    await discard();
    throw error;
  }

  return {
    commit: discard,
    async rollback(): Promise<void> {
      for (const entry of captured) {
        await rm(entry.livePath, { recursive: true, force: true }).catch(() => undefined);
        if (entry.backupPath === null) continue;
        await cp(entry.backupPath, entry.livePath, { recursive: true }).catch(() => undefined);
      }
      await discard();
    },
  };
}

/** Staging left by a process that died mid-save. Cleaned up on the next one. */
export async function discardOrphanedSkillStaging(targets: SkillTargets): Promise<void> {
  const parents = new Set(
    [targets.agentsDir, targets.claudeDir, targets.codexDir].map((root) => path.dirname(root)),
  );
  for (const parent of parents) {
    const entries = await readdir(parent).catch(() => []);
    for (const entry of entries) {
      if (!entry.startsWith(STAGING_PREFIX)) continue;
      await rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

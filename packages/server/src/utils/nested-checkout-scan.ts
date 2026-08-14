import { readdir, lstat } from "node:fs/promises";
import { resolve } from "path";
import { runGitCommand } from "./run-git-command.js";

export interface NestedCheckout {
  path: string;
  name: string;
  isWorktree: boolean;
  branch: string | null;
}

/**
 * Directory-entry ignore list shared with the file explorer scans. Entries with
 * these names are never descended into nor reported as checkouts.
 */
const IGNORED_ENTRY_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
]);

/** Max directories visited per scan — bounds work on huge trees. */
const MAX_SCANNED_DIRS = 500;
/** Scan depth: direct children are level 1, grandchildren level 2. Hidden
 *  directories ARE included (worktree collections like `.worktrees/` are the
 *  primary use case), while the ignore list above still applies inside them. */
const MAX_DEPTH = 2;

interface ScanCacheEntry {
  checkouts: NestedCheckout[];
  expiresAt: number;
}

const SCAN_CACHE_TTL_MS = 30_000;

const scanCache = new Map<string, ScanCacheEntry>();

export function invalidateNestedCheckoutScanCache(): void {
  scanCache.clear();
}

async function isGitCheckout(dir: string): Promise<boolean> {
  try {
    const dotGit = await lstat(resolve(dir, ".git"));
    return dotGit.isDirectory() || dotGit.isFile();
  } catch {
    return false;
  }
}

/** A checkout is a linked worktree when its git dir differs from the common dir. */
async function resolveCheckoutInfo(
  dir: string,
): Promise<{ branch: string | null; isWorktree: boolean }> {
  try {
    const [branchResult, gitDirResult, commonDirResult] = await Promise.all([
      runGitCommand(["branch", "--show-current"], { cwd: dir }),
      runGitCommand(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: dir }),
      runGitCommand(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir }),
    ]);
    const branch = branchResult.stdout.trim();
    const gitDir = gitDirResult.stdout.trim();
    const commonDir = commonDirResult.stdout.trim();
    return {
      branch: branch.length > 0 ? branch : null,
      isWorktree: gitDir.length > 0 && commonDir.length > 0 && gitDir !== commonDir,
    };
  } catch {
    return { branch: null, isWorktree: false };
  }
}

/**
 * Scan `root` (up to MAX_DEPTH levels) for git checkouts — main repos and linked
 * worktrees alike, including those inside hidden directories. A detected
 * checkout is reported but never descended into. The root itself is never
 * reported; callers already know about it.
 */
export async function scanForNestedCheckouts(root: string): Promise<NestedCheckout[]> {
  const cached = scanCache.get(root);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.checkouts;
  }

  const found = new Map<string, NestedCheckout>();
  let visited = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited >= MAX_SCANNED_DIRS) {
      return;
    }
    visited += 1;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }

    for (const entry of entries) {
      if (visited >= MAX_SCANNED_DIRS) {
        return;
      }
      if (IGNORED_ENTRY_NAMES.has(entry.name)) {
        continue;
      }
      // withFileTypes + isDirectory() does not follow symlinks — exactly the
      // containment we want for a scan.
      if (!entry.isDirectory()) {
        continue;
      }

      const child = resolve(dir, entry.name);
      if (await isGitCheckout(child)) {
        const info = await resolveCheckoutInfo(child);
        found.set(child, {
          path: child,
          name: entry.name,
          isWorktree: info.isWorktree,
          branch: info.branch,
        });
        continue;
      }
      await walk(child, depth + 1);
    }
  };

  await walk(root, 1);

  const checkouts = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  scanCache.set(root, { checkouts, expiresAt: Date.now() + SCAN_CACHE_TTL_MS });
  return checkouts;
}

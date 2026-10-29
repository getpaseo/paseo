import { realpath, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { getRelativePathInsideRoot } from "./path.js";

async function normalizeAbsolute(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

// Resolve a path that does not exist yet (the normal case for a worktree
// destination): realpath the nearest existing ancestor, then append the
// missing tail. A plain resolve() would let a symlinked parent smuggle
// the destination past the denylist — e.g. <repo>/alias -> <repo>/.git.
async function normalizeCandidatePath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (!(await pathExists(current))) {
    missing.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const resolvedAncestor = await normalizeAbsolute(current);
  return missing.length > 0 ? join(resolvedAncestor, ...missing) : resolvedAncestor;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Validate a worktree destination. Throws
 * with the reason on any violation; returns the normalized absolute path.
 */
export async function validateWorktreePath(options: {
  candidate: string;
  repoPath: string;
}): Promise<string> {
  const { candidate, repoPath } = options;
  if (!isAbsolute(candidate)) {
    throw new Error(
      `Worktree hook returned a relative path '${candidate}'; it must be an absolute path`,
    );
  }
  const normalized = await normalizeCandidatePath(candidate);
  const normalizedRepoPath = await normalizeAbsolute(repoPath);

  if (normalized === parse(normalized).root) {
    throw new Error("Worktree hook returned the filesystem root, which is not allowed");
  }
  if (normalized === (await normalizeAbsolute(homedir()))) {
    throw new Error("Worktree hook returned the user's home directory, which is not allowed");
  }
  if (normalized === normalizedRepoPath) {
    throw new Error("Worktree hook returned the repository root itself, which is not allowed");
  }
  if (
    [normalized, resolve(candidate)].some((path) =>
      path
        .split(sep)
        .some((part) => (process.platform === "win32" ? part.toLowerCase() : part) === ".git"),
    )
  ) {
    throw new Error(`Worktree hook returned a path inside a .git directory: ${normalized}`);
  }
  const relativeToCandidate = getRelativePathInsideRoot(normalized, normalizedRepoPath);
  if (relativeToCandidate !== null && relativeToCandidate !== "") {
    throw new Error(`Worktree hook returned an ancestor of the repository: ${normalized}`);
  }
  if ((await pathExists(normalized)) || (await pathExists(candidate))) {
    throw new Error(
      `Worktree hook returned a path that already exists: ${normalized}. Paseo creates the returned path.`,
    );
  }
  return normalized;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { execCommand } from "./spawn.js";

const EXPLICIT_BARE_REPOSITORY = ["-c", "safe.bareRepository=explicit"];

/** How a git command finds its repository. */
export interface GitDiscovery {
  configArgs: string[];
  envOverlay: ProcessEnvRecord;
}

export interface GitDiscoveryInput {
  cwd: string;
  /** The command already names its repository through `GIT_DIR`. */
  gitDirSet: boolean;
  /** From `readRepositoryRootGitDir`, read when the command was submitted. */
  repositoryRootGitDir: string | null;
  safeBareRepositorySupported: boolean;
}

interface RepositoryRoot {
  paths: readonly string[];
  gitDir: string;
}

const repositoryRoots = new AsyncLocalStorage<readonly RepositoryRoot[]>();

/**
 * Runs `operation` with `root` named as the repository of every git command
 * whose cwd is exactly `root`.
 *
 * Paseo records a bare repository as a repository root when only its linked
 * checkouts use it. Git has no `.git` to find there, so those commands receive
 * the bare repository through `GIT_DIR`. A root with a `.git` keeps normal
 * discovery, and directories below `root` are not affected.
 */
export async function runWithRepositoryRoot<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current = repositoryRoots.getStore() ?? [];
  if (findRepositoryRoot(current, root)) return operation();
  const named = await readBareRepositoryRoot(root);
  if (!named) return operation();
  return repositoryRoots.run([...current, named], operation);
}

/** The bare repository `runWithRepositoryRoot` named for `cwd` in this async context. */
export function readRepositoryRootGitDir(cwd: string): string | null {
  return findRepositoryRoot(repositoryRoots.getStore() ?? [], cwd)?.gitDir ?? null;
}

function findRepositoryRoot(
  roots: readonly RepositoryRoot[],
  cwd: string,
): RepositoryRoot | undefined {
  const path = resolve(cwd);
  return roots.find((root) => root.paths.includes(path));
}

async function readBareRepositoryRoot(root: string): Promise<RepositoryRoot | null> {
  const dotGit = await lstat(join(root, ".git")).catch(() => null);
  if (dotGit || !(await looksLikeBareRepository(root))) return null;
  const gitDir = await realpath(root).catch(() => null);
  if (!gitDir) return null;
  return { paths: [...new Set([resolve(root), gitDir])], gitDir };
}

/**
 * Keeps git from adopting a directory that only looks like a bare repository
 * (`HEAD`, `objects/`, `refs/`), at `cwd` or above it.
 *
 * A caller that works on a bare repository names it with `GIT_DIR`, directly or
 * through `runWithRepositoryRoot`.
 *
 * - Git 2.38 and later: `safe.bareRepository=explicit`.
 * - Earlier releases ignore that setting. When discovery from `cwd` would reach
 *   such a directory before any `.git`, `GIT_DIR` is pinned to the missing
 *   `<cwd>/.git`, so git reports that no repository was found.
 */
export async function resolveGitDiscovery(input: GitDiscoveryInput): Promise<GitDiscovery> {
  if (!input.gitDirSet && input.repositoryRootGitDir) {
    return {
      configArgs: EXPLICIT_BARE_REPOSITORY,
      envOverlay: { GIT_DIR: input.repositoryRootGitDir },
    };
  }
  if (input.gitDirSet || input.safeBareRepositorySupported) {
    return { configArgs: EXPLICIT_BARE_REPOSITORY, envOverlay: {} };
  }
  if (!(await discoveryReachesImplicitBareRepository(input.cwd))) {
    return { configArgs: EXPLICIT_BARE_REPOSITORY, envOverlay: {} };
  }
  return {
    configArgs: EXPLICIT_BARE_REPOSITORY,
    envOverlay: { GIT_DIR: join(input.cwd, ".git") },
  };
}

/** `safe.bareRepository` arrived in Git 2.38. */
export function parseSafeBareRepositorySupport(versionOutput: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 38);
}

let safeBareRepositorySupport: Promise<boolean> | null = null;

/** Reads `git --version` once per process. */
export function readSafeBareRepositorySupport(): Promise<boolean> {
  safeBareRepositorySupport ??= execCommand("git", ["--version"]).then(
    ({ stdout }) => parseSafeBareRepositorySupport(stdout),
    () => false,
  );
  return safeBareRepositorySupport;
}

// Follows git's discovery order: `<dir>/.git` first, then `<dir>` itself as a
// bare repository, then the parent. Git itself accepts a bare-looking directory
// that is a checkout's `.git`, or sits in its `worktrees/` or `modules/`.
async function discoveryReachesImplicitBareRepository(cwd: string): Promise<boolean> {
  let dir: string;
  try {
    dir = await realpath(cwd);
  } catch {
    return false;
  }
  while (true) {
    const dotGit = join(dir, ".git");
    if ((await isFile(dotGit)) || (await looksLikeBareRepository(dotGit))) return false;
    if (await looksLikeBareRepository(dir)) return !isInsideDotGit(dir);
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function isInsideDotGit(dir: string): boolean {
  const path = dir.replaceAll("\\", "/");
  return (
    basename(dir) === ".git" || path.includes("/.git/worktrees/") || path.includes("/.git/modules/")
  );
}

async function looksLikeBareRepository(dir: string): Promise<boolean> {
  return (
    (await isFile(join(dir, "HEAD"))) &&
    (await isDirectory(join(dir, "objects"))) &&
    (await isDirectory(join(dir, "refs")))
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

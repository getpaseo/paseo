import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { execCommand } from "./spawn.js";

const GITFILE_PREFIX = "gitdir:";
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
  safeBareRepositorySupported: boolean;
}

/**
 * Keeps git from adopting a directory that only looks like a bare repository
 * (`HEAD`, `objects/`, `refs/`), at `cwd` or above it.
 *
 * - `cwd` is a bare repository that a linked worktree points back to: no change.
 * - Git 2.38 and later: `safe.bareRepository=explicit`.
 * - Earlier releases ignore that setting. When discovery from `cwd` would reach
 *   such a directory before any `.git`, `GIT_DIR` is pinned to the missing
 *   `<cwd>/.git`, so git reports that no repository was found.
 */
export async function resolveGitDiscovery(input: GitDiscoveryInput): Promise<GitDiscovery> {
  if (await isLinkedBareRepository(input.cwd)) return { configArgs: [], envOverlay: {} };
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

/**
 * True when `cwd` is a bare repository that a linked worktree checkout points
 * back to: some `<cwd>/worktrees/<name>/gitdir` names a real `.git` file whose
 * `gitdir:` line resolves to that same `worktrees/<name>` directory. A clone
 * cannot contain `.git` files, so a directory layout that only looks like a bare
 * repository never passes. Symlinked entries and unreadable files count as not
 * linked.
 */
async function isLinkedBareRepository(cwd: string): Promise<boolean> {
  try {
    if (!(await lstat(join(cwd, "HEAD"))).isFile()) return false;
    const worktreesDir = join(await realpath(cwd), "worktrees");
    if (!(await lstat(worktreesDir)).isDirectory()) return false;
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (await isLinkedWorktreeAdminDir(worktreesDir, entry)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function isLinkedWorktreeAdminDir(worktreesDir: string, entry: Dirent): Promise<boolean> {
  if (!entry.isDirectory()) return false;
  const adminDir = join(worktreesDir, entry.name);
  try {
    const gitdirFile = join(adminDir, "gitdir");
    if (!(await lstat(gitdirFile)).isFile()) return false;
    const dotGitPath = resolve(adminDir, (await readFile(gitdirFile, "utf8")).trim());
    if (basename(dotGitPath) !== ".git") return false;
    if (!(await lstat(dotGitPath)).isFile()) return false;
    const firstLine = (await readFile(dotGitPath, "utf8")).split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith(GITFILE_PREFIX)) return false;
    const target = resolve(dirname(dotGitPath), firstLine.slice(GITFILE_PREFIX.length).trim());
    return (await realpath(target)) === adminDir;
  } catch {
    return false;
  }
}

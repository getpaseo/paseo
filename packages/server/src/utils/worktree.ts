import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, basename, dirname, resolve, sep } from "path";
import { createNameId } from "mnemonic-id";

interface PaseoConfig {
  worktree?: {
    setup?: string[];
  };
}

const execAsync = promisify(exec);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

interface RepoInfo {
  type: "bare" | "normal";
  path: string;
  name: string;
}

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
  repoType: "bare" | "normal";
  repoPath: string;
}

export type WorktreeSetupCommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export class WorktreeSetupError extends Error {
  readonly results: WorktreeSetupCommandResult[];

  constructor(message: string, results: WorktreeSetupCommandResult[]) {
    super(message);
    this.name = "WorktreeSetupError";
    this.results = results;
  }
}

export interface PaseoWorktreeInfo {
  path: string;
  branchName?: string;
  head?: string;
}

export type PaseoWorktreeOwnership = {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
};

interface CreateWorktreeOptions {
  branchName: string;
  cwd: string;
  baseBranch?: string;
  worktreeSlug?: string;
  runSetup?: boolean;
}

function readPaseoConfig(repoRoot: string): PaseoConfig | null {
  const paseoConfigPath = join(repoRoot, "paseo.json");
  if (!existsSync(paseoConfigPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paseoConfigPath, "utf8"));
  } catch {
    throw new Error(`Failed to parse paseo.json`);
  }
}

export function getWorktreeSetupCommands(repoRoot: string): string[] {
  const config = readPaseoConfig(repoRoot);
  const setupCommands = config?.worktree?.setup;
  if (!setupCommands || setupCommands.length === 0) {
    return [];
  }
  return setupCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0);
}

async function execSetupCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<WorktreeSetupCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      env: options.env,
      shell: "/bin/bash",
    });
    return {
      command,
      cwd: options.cwd,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      command,
      cwd: options.cwd,
      stdout: error?.stdout ?? "",
      stderr:
        error?.stderr ??
        (error instanceof Error ? error.message : String(error)),
      exitCode: typeof error?.code === "number" ? error.code : null,
    };
  }
}

export async function runWorktreeSetupCommands(options: {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  cleanupOnFailure: boolean;
}): Promise<WorktreeSetupCommandResult[]> {
  const setupCommands = getWorktreeSetupCommands(options.repoRoot);
  if (setupCommands.length === 0) {
    return [];
  }

  const setupEnv = {
    ...process.env,
    PASEO_ROOT_PATH: options.repoRoot,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: options.branchName,
  };

  const results: WorktreeSetupCommandResult[] = [];
  for (const cmd of setupCommands) {
    const result = await execSetupCommand(cmd, {
      cwd: options.worktreePath,
      env: setupEnv,
    });
    results.push(result);

    if (result.exitCode !== 0) {
      if (options.cleanupOnFailure) {
        try {
          await execAsync(`git worktree remove "${options.worktreePath}" --force`, {
            cwd: options.repoRoot,
          });
        } catch {
          rmSync(options.worktreePath, { recursive: true, force: true });
        }
      }
      throw new WorktreeSetupError(
        `Worktree setup command failed: ${cmd}\n${result.stderr}`.trim(),
        results
      );
    }
  }

  return results;
}

/**
 * Check if current directory is a bare repository
 */
function isBareRepo(dir: string): boolean {
  const headPath = join(dir, "HEAD");
  const refsPath = join(dir, "refs");
  const gitPath = join(dir, ".git");

  return existsSync(headPath) && existsSync(refsPath) && !existsSync(gitPath);
}

/**
 * Detect repository information (type, path, name)
 */
export async function detectRepoInfo(cwd: string): Promise<RepoInfo> {
  // Check if we're in a bare repository
  if (isBareRepo(cwd)) {
    return {
      type: "bare",
      path: cwd,
      name: basename(cwd),
    };
  }

  // Check if we're in a worktree directory (has .git file pointing to gitdir)
  const gitFilePath = join(cwd, ".git");
  if (existsSync(gitFilePath) && !existsSync(join(cwd, ".git", "HEAD"))) {
    const gitContent = readFileSync(gitFilePath, "utf8");
    const gitdirMatch = gitContent.match(/gitdir:\s*(.+)/);

    if (gitdirMatch && gitdirMatch[1]) {
      const gitdir = gitdirMatch[1].trim();

      // Check if gitdir contains .git/worktrees
      if (gitdir.includes("/.git/worktrees/")) {
        // Extract the repo path (everything before /.git/worktrees/)
        const repoRoot = gitdir.split("/.git/worktrees/")[0];
        if (repoRoot) {
          return {
            type: "normal",
            path: repoRoot,
            name: basename(repoRoot),
          };
        }
      } else {
        // Bare repo structure - worktrees are siblings
        const worktreesDir = dirname(gitdir);
        const bareRepoDir = dirname(worktreesDir);
        return {
          type: "bare",
          path: bareRepoDir,
          name: basename(bareRepoDir),
        };
      }
    }
  }

  // Fallback: allow running from any subdirectory inside a git checkout/worktree.
  // Use git's common dir (shared .git) to find the repo root even when cwd has no .git entry.
  try {
    const { stdout } = await execAsync(
      "git rev-parse --path-format=absolute --git-common-dir",
      { cwd, env: READ_ONLY_GIT_ENV }
    );
    const commonDir = stdout.trim();
    if (!commonDir) {
      throw new Error("git-common-dir was empty");
    }
    const repoRoot = basename(commonDir) === ".git" ? dirname(commonDir) : dirname(commonDir);
    return {
      type: "normal",
      path: repoRoot,
      name: basename(repoRoot),
    };
  } catch {
    throw new Error("Not in a git repository");
  }
}

/**
 * Validate that a string is a valid git branch name slug
 * Must be lowercase, alphanumeric, hyphens only
 */
export function validateBranchSlug(slug: string): {
  valid: boolean;
  error?: string;
} {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Branch name cannot be empty" };
  }

  if (slug.length > 100) {
    return { valid: false, error: "Branch name too long (max 100 characters)" };
  }

  // Check for valid characters: lowercase letters, numbers, hyphens, forward slashes
  const validPattern = /^[a-z0-9-/]+$/;
  if (!validPattern.test(slug)) {
    return {
      valid: false,
      error:
        "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
    };
  }

  // Cannot start or end with hyphen
  if (slug.startsWith("-") || slug.endsWith("-")) {
    return {
      valid: false,
      error: "Branch name cannot start or end with a hyphen",
    };
  }

  // Cannot have consecutive hyphens
  if (slug.includes("--")) {
    return { valid: false, error: "Branch name cannot have consecutive hyphens" };
  }

  return { valid: true };
}

const MAX_SLUG_LENGTH = 50;

/**
 * Convert string to kebab-case for branch names
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }

  // Truncate at word boundary (hyphen) if possible
  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen > MAX_SLUG_LENGTH / 2) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, "");
}

function generateWorktreeSlug(): string {
  return createNameId();
}

function getPaseoWorktreesRoot(repoRoot: string): string {
  return join(repoRoot, ".paseo", "worktrees");
}

export async function isPaseoOwnedWorktreeCwd(
  cwd: string
): Promise<PaseoWorktreeOwnership> {
  const repoInfo = await detectRepoInfo(cwd);
  const worktreesRoot = getPaseoWorktreesRoot(repoInfo.path);
  const resolvedRoot = resolve(worktreesRoot) + sep;
  const resolvedCwd = resolve(cwd);

  if (!resolvedCwd.startsWith(resolvedRoot)) {
    return {
      allowed: false,
      repoRoot: repoInfo.path,
      worktreeRoot: worktreesRoot,
      worktreePath: resolvedCwd,
    };
  }

  const worktrees = await listPaseoWorktrees({ cwd: repoInfo.path });
  const allowed = worktrees.some((entry) => {
    const worktreePath = resolve(entry.path);
    return resolvedCwd === worktreePath || resolvedCwd.startsWith(worktreePath + sep);
  });
  return {
    allowed,
    repoRoot: repoInfo.path,
    worktreeRoot: worktreesRoot,
    worktreePath: resolvedCwd,
  };
}

function ensurePaseoIgnoredForRepo(repoInfo: RepoInfo): {
  updated: boolean;
  skipped: boolean;
  path?: string;
} {
  if (repoInfo.type === "bare") {
    return { updated: false, skipped: true };
  }

  const gitignorePath = join(repoInfo.path, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  const hasEntry = /^\.paseo\/?$/m.test(existing);

  if (hasEntry) {
    return { updated: false, skipped: false, path: gitignorePath };
  }

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const nextContents = `${existing}${needsNewline ? "\n" : ""}.paseo/\n`;
  writeFileSync(gitignorePath, nextContents);
  return { updated: true, skipped: false, path: gitignorePath };
}

export async function ensurePaseoIgnored(cwd: string): Promise<{
  updated: boolean;
  skipped: boolean;
  path?: string;
}> {
  const repoInfo = await detectRepoInfo(cwd);
  return ensurePaseoIgnoredForRepo(repoInfo);
}

function parseWorktreeList(output: string): PaseoWorktreeInfo[] {
  const entries: PaseoWorktreeInfo[] = [];
  let current: PaseoWorktreeInfo | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.trim().length === 0) {
      if (current.path) {
        entries.push(current);
      }
      current = null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

export async function listPaseoWorktrees({
  cwd,
}: {
  cwd: string;
}): Promise<PaseoWorktreeInfo[]> {
  const repoInfo = await detectRepoInfo(cwd);
  const worktreesRoot = getPaseoWorktreesRoot(repoInfo.path);
  const { stdout } = await execAsync("git worktree list --porcelain", {
    cwd: repoInfo.path,
    env: READ_ONLY_GIT_ENV,
  });

  const rootPrefix = resolve(worktreesRoot) + sep;
  return parseWorktreeList(stdout).filter((entry) =>
    resolve(entry.path).startsWith(rootPrefix)
  );
}

export async function deletePaseoWorktree({
  cwd,
  worktreePath,
  worktreeSlug,
}: {
  cwd: string;
  worktreePath?: string;
  worktreeSlug?: string;
}): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  const repoInfo = await detectRepoInfo(cwd);
  const worktreesRoot = getPaseoWorktreesRoot(repoInfo.path);
  const targetPath = worktreePath ?? join(worktreesRoot, worktreeSlug!);
  const resolvedRoot = resolve(worktreesRoot) + sep;
  const resolvedTarget = resolve(targetPath);

  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error("Refusing to delete non-Paseo worktree");
  }

  await execAsync(`git worktree remove "${targetPath}" --force`, {
    cwd: repoInfo.path,
  });

  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
}


/**
 * Create a git worktree with proper naming conventions
 */
export async function createWorktree({
  branchName,
  cwd,
  baseBranch,
  worktreeSlug,
  runSetup = true,
}: CreateWorktreeOptions): Promise<WorktreeConfig> {
  // Validate branch name
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }

  // Detect repository info
  const repoInfo = await detectRepoInfo(cwd);

  // Ensure .paseo exists and is ignored
  ensurePaseoIgnoredForRepo(repoInfo);

  // Determine worktree directory based on repo type
  let worktreePath: string;
  const desiredSlug = worktreeSlug || generateWorktreeSlug();

  worktreePath = join(getPaseoWorktreesRoot(repoInfo.path), desiredSlug);
  mkdirSync(dirname(worktreePath), { recursive: true });

  // Check if branch already exists
  let branchExists = false;
  try {
    await execAsync(
      `git show-ref --verify --quiet refs/heads/${branchName}`,
      { cwd: repoInfo.path }
    );
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // Always create a new branch for the worktree
  // If branchName already exists, use it as base and create worktree-slug as branch name
  // If branchName doesn't exist, create it from baseBranch
  const base = branchExists ? branchName : (baseBranch ?? "HEAD");
  const candidateBranch = branchExists ? desiredSlug : branchName;

  // Find unique branch name if collision
  let newBranchName = candidateBranch;
  let suffix = 1;
  while (true) {
    try {
      await execAsync(
        `git show-ref --verify --quiet refs/heads/${newBranchName}`,
        { cwd: repoInfo.path }
      );
      // Branch exists, try with suffix
      newBranchName = `${candidateBranch}-${suffix}`;
      suffix++;
    } catch {
      break;
    }
  }

  // Also handle worktree path collision
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  while (existsSync(finalWorktreePath)) {
    finalWorktreePath = `${worktreePath}-${pathSuffix}`;
    pathSuffix++;
  }

  const command = `git worktree add "${finalWorktreePath}" -b "${newBranchName}" "${base}"`;
  await execAsync(command, { cwd: repoInfo.path });
  worktreePath = finalWorktreePath;

  if (runSetup) {
    await runWorktreeSetupCommands({
      repoRoot: repoInfo.path,
      worktreePath,
      branchName: newBranchName,
      cleanupOnFailure: true,
    });
  }

  return {
    branchName: newBranchName,
    worktreePath,
    repoType: repoInfo.type,
    repoPath: repoInfo.path,
  };
}

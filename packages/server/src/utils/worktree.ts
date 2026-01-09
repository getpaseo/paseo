import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, rmSync } from "fs";
import { join, basename, dirname } from "path";
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

interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
  repoType: "bare" | "normal";
  repoPath: string;
}

interface CreateWorktreeOptions {
  branchName: string;
  cwd: string;
  baseBranch?: string;
  worktreeSlug?: string;
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

  // Check if we're in a normal git repository
  const gitDirPath = join(cwd, ".git");
  if (existsSync(gitDirPath)) {
    try {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      const repoRoot = stdout.trim();
      return {
        type: "normal",
        path: repoRoot,
        name: basename(repoRoot),
      };
    } catch (error) {
      throw new Error("Failed to determine git repository root");
    }
  }

  throw new Error("Not in a git repository");
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


/**
 * Create a git worktree with proper naming conventions
 */
export async function createWorktree({
  branchName,
  cwd,
  baseBranch,
  worktreeSlug,
}: CreateWorktreeOptions): Promise<WorktreeConfig> {
  // Validate branch name
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }

  // Detect repository info
  const repoInfo = await detectRepoInfo(cwd);

  // Determine worktree directory based on repo type
  let worktreePath: string;
  const desiredSlug = worktreeSlug || generateWorktreeSlug();

  if (repoInfo.type === "bare") {
    worktreePath = join(repoInfo.path, desiredSlug);
  } else {
    const parentDir = dirname(repoInfo.path);
    const worktreeName = `${repoInfo.name}-${desiredSlug}`;
    worktreePath = join(parentDir, worktreeName);
  }

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

  // Run setup commands from paseo.json if present (look in source worktree, not bare repo)
  const paseoConfigPath = join(cwd, "paseo.json");
  if (existsSync(paseoConfigPath)) {
    let config: PaseoConfig;
    try {
      config = JSON.parse(readFileSync(paseoConfigPath, "utf8"));
    } catch {
      throw new Error(`Failed to parse paseo.json`);
    }

    const setupCommands = config.worktree?.setup;
    if (setupCommands && setupCommands.length > 0) {
      const setupEnv = {
        ...process.env,
        PASEO_ROOT_PATH: cwd,
        PASEO_WORKTREE_PATH: worktreePath,
        PASEO_BRANCH_NAME: newBranchName,
      };

      for (const cmd of setupCommands) {
        try {
          await execAsync(cmd, {
            cwd: worktreePath,
            env: setupEnv,
            shell: "/bin/bash",
          });
        } catch (error) {
          // Cleanup worktree on setup failure
          try {
            await execAsync(`git worktree remove "${worktreePath}" --force`, {
              cwd: repoInfo.path,
            });
          } catch {
            // If git worktree remove fails, try rmSync
            rmSync(worktreePath, { recursive: true, force: true });
          }
          throw new Error(
            `Worktree setup command failed: ${cmd}\n${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  return {
    branchName: newBranchName,
    worktreePath,
    repoType: repoInfo.type,
    repoPath: repoInfo.path,
  };
}

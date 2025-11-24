import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";

const execAsync = promisify(exec);

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

/**
 * Convert string to kebab-case for branch names
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeWorktreeSlug(input: string): string {
  const slug = slugify(input);
  return slug.length > 0 ? slug : "worktree";
}

/**
 * Check if a worktree already exists for a branch
 */
async function findExistingWorktree(
  branchName: string,
  repoPath: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoPath,
    });
    const lines = stdout.split("\n");

    let currentWorktree: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentWorktree = line.substring("worktree ".length);
      } else if (
        line === `branch refs/heads/${branchName}` &&
        currentWorktree
      ) {
        return currentWorktree;
      }
    }

    return null;
  } catch (error) {
    return null;
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
  const desiredSlug = sanitizeWorktreeSlug(worktreeSlug ?? branchName);

  if (repoInfo.type === "bare") {
    worktreePath = join(repoInfo.path, desiredSlug);
  } else {
    const parentDir = dirname(repoInfo.path);
    const worktreeName = `${repoInfo.name}-${desiredSlug}`;
    worktreePath = join(parentDir, worktreeName);
  }

  // Check if branch already exists
  try {
    await execAsync(
      `git show-ref --verify --quiet refs/heads/${branchName}`,
      { cwd: repoInfo.path }
    );

    // Branch exists, check for existing worktree
    const existingWorktree = await findExistingWorktree(
      branchName,
      repoInfo.path
    );

    if (existingWorktree) {
      if (existsSync(existingWorktree)) {
        throw new Error(
          `Worktree already exists at: ${existingWorktree}. Use 'git worktree remove ${existingWorktree}' to remove it first.`
        );
      } else {
        // Prune stale worktree reference
        await execAsync("git worktree prune", { cwd: repoInfo.path });
      }
    }

    // Create worktree using existing branch
    await execAsync(`git worktree add "${worktreePath}" "${branchName}"`, {
      cwd: repoInfo.path,
    });
  } catch (error) {
    // Branch doesn't exist, create new branch and worktree
    const baseArg = baseBranch ? ` "${baseBranch}"` : "";
    const command = `git worktree add "${worktreePath}" -b "${branchName}"${baseArg}`;
    await execAsync(command, { cwd: repoInfo.path });
  }

  // Copy .env file if it exists
  const envSource =
    repoInfo.type === "bare"
      ? join(repoInfo.path, "main", ".env")
      : join(repoInfo.path, ".env");

  if (existsSync(envSource)) {
    await execAsync(`cp "${envSource}" "${worktreePath}/.env"`);
  }

  return {
    branchName,
    worktreePath,
    repoType: repoInfo.type,
    repoPath: repoInfo.path,
  };
}

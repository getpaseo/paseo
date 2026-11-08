import { runGitCommand } from "../../utils/run-git-command.js";
import { execCommand } from "../../utils/spawn.js";

/** The branch GitButler keeps checked out while it manages a repository. */
const GITBUTLER_WORKSPACE_REF = "refs/heads/gitbutler/workspace";
const CLI_PROBE_TIMEOUT_MS = 5_000;

export interface GitButlerDetection {
  /** The `but` CLI runs on this host. */
  cliInstalled: boolean;
  /** The repository at `cwd` is managed by GitButler. */
  repositoryManaged: boolean;
}

/**
 * GitButler cannot take extra `git worktree`s: they break its workspace setup. A repository is
 * managed when `gitbutler/workspace` exists, which is also true while another branch is
 * checked out for a moment, so the ref is checked and not only the current branch.
 */
export async function detectGitButler(cwd: string): Promise<GitButlerDetection> {
  const [cliInstalled, repositoryManaged] = await Promise.all([
    isButCliInstalled(),
    hasGitButlerWorkspace(cwd),
  ]);
  return { cliInstalled, repositoryManaged };
}

async function hasGitButlerWorkspace(cwd: string): Promise<boolean> {
  try {
    await runGitCommand(["rev-parse", "--verify", "--quiet", GITBUTLER_WORKSPACE_REF], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function isButCliInstalled(): Promise<boolean> {
  try {
    await execCommand("but", ["--version"], { timeout: CLI_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

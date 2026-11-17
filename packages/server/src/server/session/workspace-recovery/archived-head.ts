import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { runGitCommand } from "../../../utils/run-git-command.js";

// Removing a worktree folder at archive deletes its HEAD, and with it the only hold on commits
// that no branch reaches. Before the folder goes, archive saves HEAD once for each workspace on
// the folder:
//
//   refs/paseo/archived/<sha256 of the workspace ID>/<git's name for HEAD>  ->  HEAD's commit
//
// The name is `git rev-parse --abbrev-ref HEAD`, stored as git prints it and never parsed here.
// The ref keeps the commit alive, and recovery hands the name back to git when it still means
// that commit, so git decides whether the worktree comes back on a branch or detached.
//
// The ref belongs to the workspace record: unarchiving the record deletes it, and nothing else
// does. The ID is hashed because pre-v0.1.95 IDs are paths, which git rejects in a ref name.
// Refs outside refs/heads, refs/tags and refs/remotes are shared by every worktree of a
// repository and hidden from branch lists, pushes and fetches.

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function savedHeadPrefix(workspaceId: string): string {
  const workspace = createHash("sha256").update(workspaceId).digest("hex");
  return `refs/paseo/archived/${workspace}/`;
}

async function listSavedHeads(cwd: string, prefix: string): Promise<string[]> {
  const { stdout } = await runGitCommand(
    ["for-each-ref", "--format=%(objectname) %(refname)", prefix],
    { cwd },
  );
  return stdout.split("\n").filter((line) => line.length > 0);
}

async function discardSavedHeads(cwd: string, prefix: string): Promise<void> {
  for (const line of await listSavedHeads(cwd, prefix)) {
    await runGitCommand(["update-ref", "-d", line.slice(line.indexOf(" ") + 1)], { cwd });
  }
}

async function isRepository(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const repository = await runGitCommand(["rev-parse", "--git-dir"], {
    cwd: path,
    acceptExitCodes: [0, 128],
  });
  return repository.exitCode === 0;
}

// git's name for the folder's HEAD, or null when the folder no longer has one: its `.git` link
// is gone, or the administration it points to is.
async function readHeadName(worktreePath: string): Promise<string | null> {
  if (!(await exists(join(worktreePath, ".git")))) return null;
  const head = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: worktreePath,
    acceptExitCodes: [0, 128],
  });
  return head.exitCode === 0 ? head.stdout.trim() : null;
}

/**
 * Saves the worktree's HEAD for each workspace on it, before archive removes its folder. A folder
 * without a HEAD has nothing to save, and what an earlier archive saved for these workspaces stays.
 */
export async function saveArchivedHead(input: {
  worktreePath: string;
  workspaceIds: readonly string[];
}): Promise<void> {
  const name = await readHeadName(input.worktreePath);
  if (!name) return;
  const cwd = input.worktreePath;
  for (const workspaceId of input.workspaceIds) {
    const prefix = savedHeadPrefix(workspaceId);
    // Delete before create: an earlier `feature` would block a new `feature/next`.
    await discardSavedHeads(cwd, prefix);
    await runGitCommand(["update-ref", `${prefix}${name}`, "HEAD"], { cwd });
  }
}

/** What recovery checks out: the saved name while it still means the saved commit, else the commit. */
export interface ArchivedHead {
  checkout: string;
  commit: string;
}

export async function readArchivedHead(input: {
  repoRoot: string;
  workspaceId: string;
}): Promise<ArchivedHead | null> {
  if (!(await isRepository(input.repoRoot))) return null;
  const prefix = savedHeadPrefix(input.workspaceId);
  const [saved] = await listSavedHeads(input.repoRoot, prefix);
  if (!saved) return null;
  const separator = saved.indexOf(" ");
  const commit = saved.slice(0, separator);
  const name = saved.slice(separator + 1 + prefix.length);
  const named = await runGitCommand(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], {
    cwd: input.repoRoot,
    acceptExitCodes: [0, 1],
  });
  return { checkout: named.stdout.trim() === commit ? name : commit, commit };
}

/**
 * Deletes the workspace's saved HEAD when it is unarchived. Throws when git cannot, so the
 * workspace stays archived with its ref rather than active with a ref a later restore would read.
 */
export async function releaseArchivedHead(input: {
  repoRoot: string;
  workspaceId: string;
}): Promise<void> {
  // Without a repository there is no ref to delete.
  if (!(await isRepository(input.repoRoot))) return;
  await discardSavedHeads(input.repoRoot, savedHeadPrefix(input.workspaceId));
}

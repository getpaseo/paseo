import { stat } from "node:fs/promises";

import { runGitCommand } from "../../../utils/run-git-command.js";

// A worktree on a detached HEAD holds commits that no branch may hold. Removing its folder at
// archive leaves those commits unreachable, and git's cleanup deletes them. Before the folder goes,
// archive records HEAD under a ref of its own, which keeps the commit alive and tells recovery
// where the worktree was. A worktree on a branch needs nothing: the branch stays in the
// repository and recovery checks it out again.
//
// Refs outside refs/heads, refs/tags and refs/remotes are shared by every worktree of a
// repository and hidden from branch lists, pushes and fetches.

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

function archivedCommitRef(workspaceId: string): string {
  return `refs/paseo/archived/${workspaceId}`;
}

/**
 * Records a detached HEAD's commit for each workspace before archive removes the worktree, and
 * clears what an earlier archive kept when HEAD is now on a branch.
 */
export async function keepArchivedCommit(input: {
  worktreePath: string;
  workspaceIds: readonly string[];
}): Promise<void> {
  // A folder that is already gone has no HEAD left to lose.
  if (input.workspaceIds.length === 0 || !(await isDirectory(input.worktreePath))) return;
  const symbolicHead = await runGitCommand(["symbolic-ref", "-q", "HEAD"], {
    cwd: input.worktreePath,
    acceptExitCodes: [0, 1],
  });
  const onBranch = symbolicHead.exitCode === 0;
  for (const workspaceId of input.workspaceIds) {
    const ref = archivedCommitRef(workspaceId);
    await runGitCommand(onBranch ? ["update-ref", "-d", ref] : ["update-ref", ref, "HEAD"], {
      cwd: input.worktreePath,
    });
  }
}

/** The commit archive kept for this workspace, or null when its HEAD was on a branch. */
export async function readArchivedCommit(input: {
  repoRoot: string;
  workspaceId: string;
}): Promise<string | null> {
  const { stdout, exitCode } = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `${archivedCommitRef(input.workspaceId)}^{commit}`],
    { cwd: input.repoRoot, acceptExitCodes: [0, 1] },
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/** Stops keeping the commit when its workspace is unarchived, however the folder came back. */
export async function releaseArchivedCommit(input: {
  repoRoot: string;
  workspaceId: string;
}): Promise<void> {
  // Without a repository there is no ref to delete.
  if (!(await isDirectory(input.repoRoot))) return;
  const repository = await runGitCommand(["rev-parse", "--git-dir"], {
    cwd: input.repoRoot,
    acceptExitCodes: [0, 128],
  });
  if (repository.exitCode !== 0) return;
  await runGitCommand(["update-ref", "-d", archivedCommitRef(input.workspaceId)], {
    cwd: input.repoRoot,
  });
}

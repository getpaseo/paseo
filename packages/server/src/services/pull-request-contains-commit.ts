import { execCommand } from "../utils/spawn.js";

/** A terminal request belongs to a checkout only when its head contains that commit. */
export async function pullRequestContainsCommit(input: {
  cwd: string;
  workspaceCommit?: string;
  pullRequestCommit?: string;
}): Promise<boolean> {
  const { cwd, workspaceCommit, pullRequestCommit } = input;
  if (!workspaceCommit || !pullRequestCommit) return false;
  if (workspaceCommit === pullRequestCommit) return true;
  // Only object IDs cross the git command boundary, never remote-supplied revisions/options.
  if (![workspaceCommit, pullRequestCommit].every((sha) => /^[a-f0-9]{40,64}$/i.test(sha))) {
    return false;
  }
  const git = (args: string[]) =>
    execCommand("git", args, {
      cwd,
      timeout: 15_000,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
    });
  try {
    try {
      await git(["cat-file", "-e", `${pullRequestCommit}^{commit}`]);
    } catch {
      // A server-side branch update need not have been fetched by this checkout.
      // Fetch objects only: preserve FETCH_HEAD and all local/tracking refs.
      await git([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "origin",
        pullRequestCommit,
      ]);
    }
    await git(["merge-base", "--is-ancestor", workspaceCommit, pullRequestCommit]);
    return true;
  } catch {
    // Missing objects, shallow history and unavailable remotes cannot prove ownership.
    return false;
  }
}

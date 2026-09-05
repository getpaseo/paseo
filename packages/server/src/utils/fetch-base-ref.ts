import { createRunGitCommand, type RunGitCommand } from "./run-git-command.js";
import { branchNameFromRef } from "./worktree-metadata.js";

const REMOTE_TRACKING_PREFIX = "refs/remotes/";
const DEFAULT_REMOTE = "origin";

// Long enough for a single-branch fetch on a slow link, short enough that a
// wedged remote does not hold workspace creation open the way the blocking
// checkout-branch fetch (120s) can.
const FETCH_TIMEOUT_MS = 30_000;

export interface BaseRefFetchTarget {
  remote: string;
  branch: string;
}

/**
 * Which remote and branch to refresh before branching off `baseBranch`.
 *
 * The base reaches us in three shapes: a qualified remote-tracking ref
 * ("refs/remotes/upstream/main", which a fork's upstream produces), a qualified
 * local ref ("refs/heads/main"), or a short name ("main", "origin/main").
 * Only the qualified remote-tracking form names its remote; everything else can
 * only be looked for on origin, for the same reason `branchNameFromRef` cannot
 * generalize the short form — without the remote list "feature/x" and
 * "<remote>/x" are indistinguishable.
 *
 * Returns null when there is nothing fetchable to derive.
 */
export function resolveBaseRefFetchTarget(baseBranch: string): BaseRefFetchTarget | null {
  const trimmed = baseBranch.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith(REMOTE_TRACKING_PREFIX)) {
    const remainder = trimmed.slice(REMOTE_TRACKING_PREFIX.length);
    const separator = remainder.indexOf("/");
    if (separator <= 0) {
      return null;
    }
    const remote = remainder.slice(0, separator);
    const branch = remainder.slice(separator + 1);
    return branch.length > 0 ? { remote, branch } : null;
  }
  const branch = branchNameFromRef(trimmed);
  return branch.length > 0 ? { remote: DEFAULT_REMOTE, branch } : null;
}

const runBaseRefFetch = createRunGitCommand("workspace-create-base");

/**
 * Refresh one branch from its remote so a new worktree branches off the newest
 * upstream commit instead of whatever the last background fetch left behind.
 *
 * Deliberately narrow: one branch, never `--prune`, never the repository-wide
 * refspec, so it stays cheap on partial clones with thousands of remote
 * branches. `git fetch <remote> <branch>` still updates
 * refs/remotes/<remote>/<branch> opportunistically, honouring whatever
 * remote.<remote>.fetch the user configured.
 *
 * Never throws. Returns whether the remote ref was actually refreshed.
 */
export async function fetchBaseRefFromRemote(
  cwd: string,
  baseBranch: string,
  run: RunGitCommand = runBaseRefFetch,
): Promise<boolean> {
  const target = resolveBaseRefFetchTarget(baseBranch);
  if (!target) {
    return false;
  }
  if (!(await remoteExists(cwd, target.remote, run))) {
    return false;
  }
  try {
    await run(["fetch", target.remote, target.branch], {
      cwd,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
      timeout: FETCH_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Offline, no credentials, or a base that only exists locally. Creating the
    // workspace matters more than starting it from the newest commit, so fall
    // through and branch from whatever the local refs already hold.
    return false;
  }
}

async function remoteExists(cwd: string, remote: string, run: RunGitCommand): Promise<boolean> {
  try {
    const { stdout } = await run(["config", "--get", `remote.${remote}.url`], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The remote-tracking ref to branch from instead of the local branch, or null to
 * leave the caller's resolution alone.
 *
 * `resolveRepositoryDefaultBranch` and the base-ref picker both hand us a bare
 * branch name, and `resolveBaseBranchForWorktree` resolves those local-first —
 * so a freshly fetched origin/main would still be ignored in favour of a stale
 * local main. That is the asymmetry that makes a brand-new worktree open with an
 * "Update from main" button: creation reads the local ref while the comparison
 * side picks whichever ref is further ahead.
 *
 * Only strictly-behind counts. If the local branch holds commits the remote does
 * not, branching off the remote would silently drop them, so local wins. An
 * explicitly qualified ref is the caller's deliberate choice and is never
 * second-guessed.
 */
export async function preferFastForwardedRemoteRef(
  cwd: string,
  baseBranch: string,
  run: RunGitCommand = runBaseRefFetch,
): Promise<string | null> {
  const trimmed = baseBranch.trim();
  if (trimmed.startsWith(REMOTE_TRACKING_PREFIX) || trimmed.startsWith(`${DEFAULT_REMOTE}/`)) {
    return null;
  }
  const target = resolveBaseRefFetchTarget(trimmed);
  if (!target) {
    return null;
  }
  const localRef = `refs/heads/${target.branch}`;
  const remoteRef = `${REMOTE_TRACKING_PREFIX}${target.remote}/${target.branch}`;
  try {
    const { stdout } = await run(
      ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`],
      { cwd },
    );
    const [localOnlyRaw, remoteOnlyRaw] = stdout.trim().split(/\s+/);
    const localOnly = Number.parseInt(localOnlyRaw ?? "", 10);
    const remoteOnly = Number.parseInt(remoteOnlyRaw ?? "", 10);
    if (!Number.isFinite(localOnly) || !Number.isFinite(remoteOnly)) {
      return null;
    }
    return localOnly === 0 && remoteOnly > 0 ? remoteRef : null;
  } catch {
    // Either ref may be missing (a local-only branch, or one never pushed).
    return null;
  }
}

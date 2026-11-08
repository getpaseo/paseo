/**
 * Which workspaces deserve a git observation. A watched workspace costs a
 * working-tree watcher, a repository-metadata watcher, a periodic fetch and a
 * pull-request poll, so a workspace only earns one while something is happening
 * in it. Everything else is served on demand by `checkout_status_request` and
 * starts being watched through `syncWorkspaceGitObserverForWorkspace` the moment
 * it is touched.
 *
 * Re-evaluation rides existing lifecycle events (agent state, terminal changes,
 * workspace mutations). There is deliberately no timer here.
 */
export const WORKSPACE_LIVENESS_WINDOW_MS = 15 * 60_000;

export interface WorkspaceLivenessFacts {
  /** Newest activity Paseo knows about: the workspace record's update or a human prompt. */
  lastActivityAt: string | null;
  hasLoadedAgent: boolean;
  hasOpenAgentTab: boolean;
  hasLiveTerminal: boolean;
  hasRunningScript: boolean;
  /** A client narrowed `fetch_workspaces` to this workspace. */
  isExplicitlySubscribed: boolean;
  /** Auto-archive-on-merge is on and this workspace is a Paseo-owned worktree. */
  isAutoArchiveCandidate: boolean;
  /** The last known git snapshot has an open pull request. */
  hasOpenPullRequest: boolean;
}

export function isLiveWorkspace(facts: WorkspaceLivenessFacts, now: number = Date.now()): boolean {
  if (
    facts.hasLoadedAgent ||
    facts.hasOpenAgentTab ||
    facts.hasLiveTerminal ||
    facts.hasRunningScript ||
    facts.isExplicitlySubscribed ||
    facts.isAutoArchiveCandidate ||
    facts.hasOpenPullRequest
  ) {
    return true;
  }
  if (!facts.lastActivityAt) {
    return false;
  }
  const activityAt = Date.parse(facts.lastActivityAt);
  return Number.isFinite(activityAt) && now - activityAt <= WORKSPACE_LIVENESS_WINDOW_MS;
}

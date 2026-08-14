import type { Logger } from "pino";

import {
  archiveIfSafe,
  type ArchiveIfSafeDependencies,
  type AutoArchiveArchiveOptions,
} from "./archive-if-safe.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitSubscription,
} from "../workspace-git-service.js";

export interface AutoArchiveOnMergeOptions extends AutoArchiveArchiveOptions {
  logger: Logger;
}

// why: the poll is the correctness backstop (see setupAutoArchiveOnMerge), not
// the primary path, so this only bounds how late a stuck-internal-agent
// workspace gets swept — 30s is frequent enough not to matter in practice.
export const DEFERRED_POLL_INTERVAL_MS = 30_000;

export function setupAutoArchiveOnMerge({
  options,
  deps,
}: {
  options: AutoArchiveOnMergeOptions;
  deps?: ArchiveIfSafeDependencies;
}): WorkspaceGitSubscription {
  const log = options.logger.child({ module: "auto-archive-on-merge" });
  const inFlight = new Set<string>();
  // why: a workspace deferred for a live agent (#2886) needs to be re-checked
  // once every attached agent goes idle. AgentManager.dispatch() hides
  // internal agents' (e.g. branch-name/git-metadata generators) agent_state
  // events from global subscribers like the one below, so an internal-agent
  // -only defer would never get retried by events alone — poll every watched
  // cwd periodically as the correctness backstop; the event subscription
  // below is just a fast path that reacts sooner in the common case.
  const watchedCwds = new Set<string>();

  async function attemptArchive(input: {
    cwd: string;
    pullRequest: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
  }): Promise<void> {
    const { cwd, pullRequest } = input;
    const outcome = await archiveIfSafe({ cwd, pullRequest, inFlight, options, log, deps });
    if (outcome.status === "deferred" || outcome.status === "inconclusive") {
      // "inconclusive" (an in-flight collision, a snapshot read that failed
      // even after retry, or an archive attempt that threw) means no verdict
      // was reached at all — keep watching so the poll or next idle event
      // tries again, exactly like "deferred".
      watchedCwds.add(cwd);
    } else {
      // Every other outcome ("archived" or a genuine "skipped" — not merged,
      // disabled, dirty, branch mismatch, etc.) means this cwd will never
      // become archivable by polling alone, so stop watching it: further
      // eligibility can only come from a fresh onSnapshotUpdated event.
      watchedCwds.delete(cwd);
    }
  }

  async function recheckWatchedCwds(): Promise<void> {
    for (const cwd of watchedCwds) {
      let snapshot: WorkspaceGitRuntimeSnapshot | null;
      try {
        snapshot = await options.workspaceGitService.getSnapshot(cwd, {
          reason: "auto-archive-on-merge-recheck",
        });
      } catch (error) {
        log.debug(
          { err: error, cwd },
          "Failed to read snapshot while rechecking a deferred auto-archive; will retry",
        );
        continue;
      }
      if (!snapshot) {
        watchedCwds.delete(cwd);
        continue;
      }
      void attemptArchive({ cwd, pullRequest: snapshot.forge.pullRequest });
    }
  }

  const gitSubscription = options.workspaceGitService.onSnapshotUpdated((snapshot) => {
    void attemptArchive({ cwd: snapshot.cwd, pullRequest: snapshot.forge.pullRequest });
  });

  const pollTimer = setInterval(() => {
    void recheckWatchedCwds();
  }, DEFERRED_POLL_INTERVAL_MS);
  pollTimer.unref?.();

  const unsubscribeAgentEvents = options.agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_state" || !event.agent.workspaceId) {
        return;
      }
      // why: agent_state fires on every busy-state update (token usage, mode
      // changes, etc.) during a turn, not just idle transitions — only a
      // transition to idle can unblock a deferred archive, so skip the
      // expensive re-check (which shells out to git) while still busy.
      if (options.agentManager.hasInFlightRun(event.agent.id)) {
        return;
      }
      void recheckWatchedCwds();
    },
    { replayState: false },
  );

  return {
    unsubscribe: () => {
      clearInterval(pollTimer);
      gitSubscription.unsubscribe();
      unsubscribeAgentEvents();
    },
  };
}

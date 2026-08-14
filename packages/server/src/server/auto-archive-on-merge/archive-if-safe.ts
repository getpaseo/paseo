import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  killTerminalsForWorkspace,
  resolveWorkspaceIdAtPath,
} from "../workspace-archive-service.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitServiceImpl,
} from "../workspace-git-service.js";
import type { ForgeService } from "../../services/forge-service.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import type { WorkspaceArchiveContext } from "../workspace-registry.js";

export interface AutoArchiveArchiveOptions {
  paseoHome: string;
  paseoWorktreesBaseRoot?: string;
  daemonConfigStore: DaemonConfigStore;
  workspaceGitService: WorkspaceGitServiceImpl;
  github: ForgeService;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  getAutoArchivedChangeRequestUrl: (workspaceId: string) => Promise<string | null>;
  archiveWorkspaceRecord: (workspaceId: string, context?: WorkspaceArchiveContext) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
}

export interface ArchiveIfSafeDependencies {
  archiveByScope: typeof archiveByScope;
  resolveWorkspaceIdAtPath: typeof resolveWorkspaceIdAtPath;
  isPaseoOwnedWorktreeCwd: typeof isPaseoOwnedWorktreeCwd;
  killTerminalsForWorkspace: typeof killTerminalsForWorkspace;
}

const defaultDependencies: ArchiveIfSafeDependencies = {
  archiveByScope,
  resolveWorkspaceIdAtPath,
  isPaseoOwnedWorktreeCwd,
  killTerminalsForWorkspace,
};

export type ArchiveIfSafeOutcome =
  | { status: "archived" }
  | { status: "skipped" }
  // why: "skipped" is a verdict about the workspace (not merged, disabled,
  // dirty, branch mismatch, already handled, ...) — it means don't bother
  // rechecking without a new git/forge event. "inconclusive" means the check
  // itself failed for a transient reason (a concurrent in-flight collision, a
  // snapshot read that failed even after retry, an archive attempt that
  // threw) with no judgment reached at all — callers that track "worth
  // rechecking" (e.g. the deferred-workspace poll in index.ts) must keep
  // watching a cwd on "inconclusive" the same way they would on "deferred".
  | { status: "inconclusive" }
  | { status: "deferred"; workspaceId: string };

const SKIPPED: ArchiveIfSafeOutcome = { status: "skipped" };

export async function archiveIfSafe(input: {
  cwd: string;
  pullRequest: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
  inFlight: Set<string>;
  options: AutoArchiveArchiveOptions;
  log: Logger;
  deps?: ArchiveIfSafeDependencies;
}): Promise<ArchiveIfSafeOutcome> {
  const { cwd, pullRequest, inFlight, options, log } = input;
  const deps = input.deps ?? defaultDependencies;

  if (!pullRequest?.isMerged) {
    return SKIPPED;
  }
  if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
    return SKIPPED;
  }
  if (inFlight.has(cwd)) {
    return { status: "inconclusive" };
  }

  inFlight.add(cwd);
  try {
    let snapshot: Awaited<ReturnType<typeof options.workspaceGitService.getSnapshot>> | null;
    try {
      snapshot = await options.workspaceGitService.getSnapshot(cwd, {
        reason: "auto-archive-on-merge",
      });
    } catch (firstError) {
      // why: a workspace deferred for a live agent (#2886) is only re-checked
      // when that agent later goes idle — a bare git-read hiccup right at that
      // moment would otherwise leave it deferred forever, so retry once
      // immediately before giving up.
      log.debug(
        { err: firstError, cwd },
        "Failed to read snapshot for auto-archive; retrying once",
      );
      try {
        snapshot = await options.workspaceGitService.getSnapshot(cwd, {
          reason: "auto-archive-on-merge",
        });
      } catch (error) {
        log.warn(
          { err: error, cwd },
          "Failed to read snapshot for auto-archive after a retry; will try again later",
        );
        return { status: "inconclusive" };
      }
    }
    if (!snapshot) {
      return SKIPPED;
    }

    // why: a merged PR anywhere in the repo must not reap an unrelated worktree
    // (#2886) — only the PR for this worktree's own head branch is eligible.
    // Exact match only: a fork-PR checkout can name its local branch
    // "<owner>/<headRef>" (see doesLocalBranchNameIdentifyTrackedHead in
    // checkout-git.ts), but WorkspaceGitRuntimeSnapshot's pullRequest carries
    // no headRepositoryOwner to verify that prefix against, and a suffix-only
    // match ("bob/feature" matching a merged "alice/feature" PR) reopens the
    // same false-positive-archive class this check exists to close. Known
    // limitation: fork-PR checkouts using that convention won't auto-archive.
    if (snapshot.git.currentBranch !== pullRequest.headRefName) {
      log.info(
        {
          cwd,
          currentBranch: snapshot.git.currentBranch,
          pullRequestHeadRefName: pullRequest.headRefName,
        },
        "Skipping auto-archive: merged PR's head branch does not match this worktree",
      );
      return SKIPPED;
    }

    if (snapshot.git.isDirty === true) {
      return SKIPPED;
    }
    if (typeof snapshot.git.aheadOfOrigin === "number" && snapshot.git.aheadOfOrigin > 0) {
      return SKIPPED;
    }

    const ownership = await deps.isPaseoOwnedWorktreeCwd(cwd, {
      paseoHome: options.paseoHome,
      worktreesRoot: options.paseoWorktreesBaseRoot,
    });
    if (!ownership.allowed) {
      return SKIPPED;
    }

    try {
      const workspaceId = await deps.resolveWorkspaceIdAtPath(
        {
          findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
          listActiveWorkspaces: options.listActiveWorkspaces,
        },
        cwd,
      );
      if (!workspaceId) {
        log.warn({ cwd }, "Auto-archive could not resolve a workspace for cwd; skipping");
        return SKIPPED;
      }
      const autoArchivedChangeRequestUrl =
        await options.getAutoArchivedChangeRequestUrl(workspaceId);
      if (autoArchivedChangeRequestUrl === pullRequest.url) {
        return SKIPPED;
      }

      // why: closing a running provider session mid-turn corrupts it (#2886) —
      // defer archival until every attached agent in this workspace is idle.
      // hasWorkspaceInFlightRun (not listAgents + hasInFlightRun) because
      // listAgents() hides internal agents, which must still block archival.
      if (options.agentManager.hasWorkspaceInFlightRun(workspaceId)) {
        log.info(
          { cwd, workspaceId },
          "Deferring auto-archive after merge until attached agent is idle",
        );
        return { status: "deferred", workspaceId };
      }

      await deps.archiveByScope(
        {
          paseoHome: options.paseoHome,
          paseoWorktreesBaseRoot: options.paseoWorktreesBaseRoot,
          github: options.github,
          workspaceGitService: options.workspaceGitService,
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
          listActiveWorkspaces: options.listActiveWorkspaces,
          archiveWorkspaceRecord: (workspaceIdToArchive) =>
            options.archiveWorkspaceRecord(workspaceIdToArchive, {
              autoArchivedChangeRequestUrl: pullRequest.url,
            }),
          emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
          markWorkspaceArchiving: options.markWorkspaceArchiving,
          clearWorkspaceArchiving: options.clearWorkspaceArchiving,
          killTerminalsForWorkspace: (workspaceIdToKill) =>
            deps.killTerminalsForWorkspace(
              {
                terminalManager: options.terminalManager,
                sessionLogger: log,
              },
              workspaceIdToKill,
            ),
          sessionLogger: log,
        },
        {
          scope: { kind: "workspace", workspaceId },
          requestId: "auto-archive-on-merge",
        },
      );
      log.info({ cwd }, "Auto-archived worktree after PR merge");
      return { status: "archived" };
    } catch (error) {
      log.warn({ err: error, cwd }, "Auto-archive after merge failed; will try again later");
      return { status: "inconclusive" };
    }
  } finally {
    inFlight.delete(cwd);
  }
}

import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  killTerminalsForWorkspace,
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
  isPaseoOwnedWorktreeCwd: typeof isPaseoOwnedWorktreeCwd;
  killTerminalsForWorkspace: typeof killTerminalsForWorkspace;
}

const defaultDependencies: ArchiveIfSafeDependencies = {
  archiveByScope,
  isPaseoOwnedWorktreeCwd,
  killTerminalsForWorkspace,
};

export async function archiveIfSafe(input: {
  workspaceId: string;
  cwd: string;
  pullRequest: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
  inFlight: Set<string>;
  options: AutoArchiveArchiveOptions;
  log: Logger;
  deps?: ArchiveIfSafeDependencies;
}): Promise<void> {
  const { workspaceId, cwd, pullRequest: observedPullRequest, inFlight, options, log } = input;
  const deps = input.deps ?? defaultDependencies;

  if (!observedPullRequest?.isMerged) {
    return;
  }
  if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
    return;
  }
  if (inFlight.has(workspaceId)) {
    return;
  }

  inFlight.add(workspaceId);
  try {
    let snapshot: Awaited<ReturnType<typeof options.workspaceGitService.getSnapshot>> | null;
    try {
      snapshot = await options.workspaceGitService.getSnapshot(cwd, {
        reason: "auto-archive-on-merge",
      });
    } catch (error) {
      log.warn({ err: error, cwd }, "Failed to read snapshot for auto-archive; skipping");
      return;
    }
    if (!snapshot) {
      return;
    }
    const pullRequest = snapshot.forge.pullRequest;
    if (!pullRequest?.isMerged) {
      return;
    }

    if (snapshot.git.isDirty === true) {
      return;
    }
    if (typeof snapshot.git.aheadOfOrigin === "number" && snapshot.git.aheadOfOrigin > 0) {
      return;
    }

    const ownership = await deps.isPaseoOwnedWorktreeCwd(cwd, {
      paseoHome: options.paseoHome,
      worktreesRoot: options.paseoWorktreesBaseRoot,
    });
    if (!ownership.allowed) {
      return;
    }

    try {
      const autoArchivedChangeRequestUrl =
        await options.getAutoArchivedChangeRequestUrl(workspaceId);
      if (autoArchivedChangeRequestUrl === pullRequest.url) {
        return;
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
      log.info(
        { workspaceId, cwd, branch: pullRequest.headRefName, pullRequestUrl: pullRequest.url },
        "Auto-archived worktree after PR merge",
      );
    } catch (error) {
      log.warn({ err: error, cwd }, "Auto-archive after merge failed");
    }
  } finally {
    inFlight.delete(workspaceId);
  }
}

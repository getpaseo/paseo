import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  type ActiveWorkspaceRef,
  archivePaseoWorktree,
  killTerminalsForWorkspace,
} from "../paseo-worktree-archive-service.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitServiceImpl,
} from "../workspace-git-service.js";
import type { GitHubService } from "../../services/github-service.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";

export interface AutoArchiveArchiveOptions {
  paseoHome: string;
  worktreesRoot?: string;
  daemonConfigStore: DaemonConfigStore;
  workspaceGitService: WorkspaceGitServiceImpl;
  github: GitHubService;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  resolveWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
}

export interface ArchiveIfSafeDependencies {
  archivePaseoWorktree: typeof archivePaseoWorktree;
  isPaseoOwnedWorktreeCwd: typeof isPaseoOwnedWorktreeCwd;
  killTerminalsForWorkspace: typeof killTerminalsForWorkspace;
}

const defaultDependencies: ArchiveIfSafeDependencies = {
  archivePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  killTerminalsForWorkspace,
};

export async function archiveIfSafe(input: {
  cwd: string;
  pullRequest: WorkspaceGitRuntimeSnapshot["github"]["pullRequest"];
  inFlight: Set<string>;
  options: AutoArchiveArchiveOptions;
  log: Logger;
  deps?: ArchiveIfSafeDependencies;
}): Promise<void> {
  const { cwd, pullRequest, inFlight, options, log } = input;
  const deps = input.deps ?? defaultDependencies;

  if (!pullRequest?.isMerged) {
    return;
  }
  if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
    return;
  }
  if (inFlight.has(cwd)) {
    return;
  }

  inFlight.add(cwd);
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

    if (snapshot.git.isDirty === true) {
      return;
    }
    if (typeof snapshot.git.aheadOfOrigin === "number" && snapshot.git.aheadOfOrigin > 0) {
      return;
    }

    const ownership = await deps.isPaseoOwnedWorktreeCwd(cwd, {
      paseoHome: options.paseoHome,
      worktreesRoot: options.worktreesRoot,
    });
    if (!ownership.allowed) {
      return;
    }

    try {
      await deps.archivePaseoWorktree(
        {
          paseoHome: options.paseoHome,
          worktreesRoot: options.worktreesRoot,
          github: options.github,
          workspaceGitService: options.workspaceGitService,
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          resolveWorkspaceIdForCwd: options.resolveWorkspaceIdForCwd,
          listActiveWorkspaces: options.listActiveWorkspaces,
          archiveWorkspaceRecord: options.archiveWorkspaceRecord,
          emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
          markWorkspaceArchiving: options.markWorkspaceArchiving,
          clearWorkspaceArchiving: options.clearWorkspaceArchiving,
          killTerminalsForWorkspace: (workspaceId) =>
            deps.killTerminalsForWorkspace(
              {
                terminalManager: options.terminalManager,
                sessionLogger: log,
              },
              workspaceId,
            ),
          sessionLogger: log,
        },
        {
          targetPath: cwd,
          repoRoot: ownership.repoRoot ?? null,
          worktreesRoot: ownership.worktreeRoot,
          worktreesBaseRoot: options.worktreesRoot,
          // Last-reference + Paseo-ownership gated inside the service, so sibling
          // workspaces sharing the directory stay protected. Removing the merged
          // worktree off disk prevents merged worktrees from accumulating.
          deleteWorktreeFromDisk: true,
          requestId: "auto-archive-on-merge",
        },
      );
      log.info({ cwd }, "Auto-archived worktree after PR merge");
    } catch (error) {
      log.warn({ err: error, cwd }, "Auto-archive after merge failed");
    }
  } finally {
    inFlight.delete(cwd);
  }
}

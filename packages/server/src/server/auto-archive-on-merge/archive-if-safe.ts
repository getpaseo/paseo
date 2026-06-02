import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { archivePaseoWorktree, killTerminalsUnderPath } from "../paseo-worktree-archive-service.js";
import { isSameOrDescendantPath } from "../path-utils.js";
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
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
}

export interface ArchiveIfSafeDependencies {
  archivePaseoWorktree: typeof archivePaseoWorktree;
  isPaseoOwnedWorktreeCwd: typeof isPaseoOwnedWorktreeCwd;
  killTerminalsUnderPath: typeof killTerminalsUnderPath;
  isPathWithinRoot: typeof isSameOrDescendantPath;
}

const defaultDependencies: ArchiveIfSafeDependencies = {
  archivePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  killTerminalsUnderPath,
  isPathWithinRoot: isSameOrDescendantPath,
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

    if (snapshot.git.isDirty === true || (snapshot.git.aheadOfOrigin ?? 0) > 0) {
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
          archiveWorkspaceRecord: options.archiveWorkspaceRecord,
          emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
          markWorkspaceArchiving: options.markWorkspaceArchiving,
          clearWorkspaceArchiving: options.clearWorkspaceArchiving,
          isPathWithinRoot: deps.isPathWithinRoot,
          killTerminalsUnderPath: (rootPath) =>
            deps.killTerminalsUnderPath(
              {
                terminalManager: options.terminalManager,
                isPathWithinRoot: deps.isPathWithinRoot,
                killTrackedTerminal: () => {},
                sessionLogger: log,
              },
              rootPath,
            ),
          sessionLogger: log,
        },
        {
          targetPath: cwd,
          repoRoot: ownership.repoRoot ?? null,
          worktreesRoot: ownership.worktreeRoot,
          worktreesBaseRoot: options.worktreesRoot,
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

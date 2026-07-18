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
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
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

/**
 * Fail-closed snapshot gates for auto-archive. Inclusion (exact/included) is
 * evidence for safety only after the explicit autoArchiveAfterMerge setting —
 * never initiates archive by itself. See docs/origin-default-relation.md.
 */
export function isSnapshotSafeForAutoArchive(snapshot: WorkspaceGitRuntimeSnapshot): boolean {
  // Unknown dirty state is not known-safe — require an explicit clean tree.
  if (snapshot.git.isDirty !== false) {
    return false;
  }
  // Detached / ambiguous HEAD is not a named worktree tip we will auto-delete.
  if (!snapshot.git.currentBranch) {
    return false;
  }
  const relation = snapshot.git.originDefaultRelation;
  if (!relation) {
    return false;
  }
  if (relation.state !== "exact" && relation.state !== "included") {
    return false;
  }
  // Null/undefined ahead is unknown; only exact zero is known-safe.
  if (relation.ahead !== 0) {
    return false;
  }
  // Null/undefined uniquePatchCount is unknown; only exact zero is known-safe.
  if (relation.uniquePatchCount !== 0) {
    return false;
  }
  // Legacy push risk: null/undefined is unknown; only exact zero is known-safe.
  if (snapshot.git.aheadOfOrigin !== 0) {
    return false;
  }
  return true;
}

export async function archiveIfSafe(input: {
  cwd: string;
  pullRequest: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
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
    if (!snapshot || !isSnapshotSafeForAutoArchive(snapshot)) {
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
      const workspaceId = await deps.resolveWorkspaceIdAtPath(
        {
          findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
          listActiveWorkspaces: options.listActiveWorkspaces,
        },
        cwd,
      );
      if (!workspaceId) {
        log.warn({ cwd }, "Auto-archive could not resolve a workspace for cwd; skipping");
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
          archiveWorkspaceRecord: options.archiveWorkspaceRecord,
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
    } catch (error) {
      log.warn({ err: error, cwd }, "Auto-archive after merge failed");
    }
  } finally {
    inFlight.delete(cwd);
  }
}

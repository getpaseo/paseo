import { resolve } from "node:path";
import type pino from "pino";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

const WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY = "__removed__";

interface WorkspaceGitWatchTarget {
  cwd: string;
  workspaceId: string;
  latestDescriptorStateKey: string | null;
  lastBranchName: string | null;
}

/**
 * Observes a workspace's git state on disk (via WorkspaceGitService) and drives the
 * live update fan-out: branch-change notifications, workspace-card refreshes, and
 * checkout status updates. It owns the per-cwd watch targets and the WorkspaceGitService
 * subscription handles, so the registration / dedupe / teardown lifecycle lives in one
 * module instead of being smeared across the client session.
 *
 * Branch changes reach `onBranchChanged` from two paths that share `lastBranchName`: the
 * on-disk snapshot listener (handleBranchSnapshot) and the workspace-emit loop
 * (recordDescriptorState). Both stay inside this module so the shared state is coherent.
 */
export interface WorkspaceGitObserverService {
  syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void;
  syncObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void>;
  warmGitData(workspace: PersistedWorkspaceRecord): Promise<void>;
  // Check-and-record dedupe gate: returns true when the descriptor state is unchanged
  // for this workspace, and otherwise advances the recorded state key as a side effect.
  shouldSkipUpdate(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): boolean;
  recordDescriptorState(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): void;
  handleBranchSnapshot(cwd: string, branchName: string | null): void;
  removeForWorkspaceId(workspaceId: string): void;
  removeForCwd(cwd: string): void;
  dispose(): void;
}

export function createWorkspaceGitObserverService(deps: {
  workspaceGitService: Pick<WorkspaceGitService, "registerWorkspace">;
  describeWorkspaceRecordWithGitData: (
    workspace: PersistedWorkspaceRecord,
  ) => Promise<WorkspaceDescriptorPayload>;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  emitStatusUpdate: (cwd: string, snapshot: WorkspaceGitRuntimeSnapshot) => void;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  logger: pino.Logger;
}): WorkspaceGitObserverService {
  const {
    workspaceGitService,
    describeWorkspaceRecordWithGitData,
    emitWorkspaceUpdateForCwd,
    emitWorkspaceUpdateForWorkspaceId,
    emitStatusUpdate,
    onBranchChanged,
    logger,
  } = deps;

  const watchTargets = new Map<string, WorkspaceGitWatchTarget>();
  const subscriptions = new Map<string, () => void>();

  function descriptorStateKey(workspace: WorkspaceDescriptorPayload | null): string {
    if (!workspace) {
      return WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY;
    }
    return JSON.stringify([
      workspace.name,
      workspace.diffStat ? [workspace.diffStat.additions, workspace.diffStat.deletions] : null,
    ]);
  }

  function resolveTargetByWorkspaceId(workspaceId: string): WorkspaceGitWatchTarget | null {
    for (const target of watchTargets.values()) {
      if (target.workspaceId === workspaceId) {
        return target;
      }
    }
    return null;
  }

  function rememberDescriptorState(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): void {
    const target = resolveTargetByWorkspaceId(workspaceId);
    if (!target) {
      return;
    }
    target.latestDescriptorStateKey = descriptorStateKey(workspace);
    target.lastBranchName = workspace?.name ?? null;
  }

  function removeForCwd(cwd: string): void {
    const normalizedCwd = resolve(cwd);
    watchTargets.delete(normalizedCwd);
    subscriptions.get(normalizedCwd)?.();
    subscriptions.delete(normalizedCwd);
  }

  function handleBranchSnapshot(cwd: string, branchName: string | null): void {
    const target = watchTargets.get(resolve(cwd));
    if (!target) {
      return;
    }

    const previousBranchName = target.lastBranchName;
    if (branchName === previousBranchName) {
      return;
    }

    target.lastBranchName = branchName;
    onBranchChanged?.(target.workspaceId, previousBranchName, branchName);
  }

  function syncObserver(cwd: string, options: { isGit: boolean; workspaceId: string }): void {
    const normalizedCwd = resolve(cwd);
    if (!options.isGit) {
      removeForCwd(normalizedCwd);
      return;
    }

    if (subscriptions.has(normalizedCwd)) {
      return;
    }

    const target: WorkspaceGitWatchTarget = {
      cwd: normalizedCwd,
      workspaceId: options.workspaceId,
      latestDescriptorStateKey: null,
      lastBranchName: null,
    };
    watchTargets.set(normalizedCwd, target);

    const subscription = workspaceGitService.registerWorkspace(
      { cwd: normalizedCwd },
      (snapshot) => {
        handleBranchSnapshot(normalizedCwd, snapshot.git.currentBranch ?? null);
        void emitWorkspaceUpdateForCwd(normalizedCwd).catch((error) => {
          logger.warn(
            { err: error, cwd: normalizedCwd },
            "Failed to emit workspace update after git branch snapshot",
          );
        });
        emitStatusUpdate(normalizedCwd, snapshot);
      },
    );
    subscriptions.set(normalizedCwd, subscription.unsubscribe);
  }

  function syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void {
    for (const workspace of workspaces) {
      syncObserver(workspace.workspaceDirectory, {
        isGit: workspace.projectKind === "git",
        workspaceId: workspace.id,
      });
      rememberDescriptorState(workspace.workspaceDirectory, workspace);
    }
  }

  async function syncObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    const descriptor = await describeWorkspaceRecordWithGitData(workspace);
    syncObservers([descriptor]);
  }

  return {
    syncObservers,
    syncObserverForWorkspace,

    async warmGitData(workspace) {
      await syncObserverForWorkspace(workspace);
      await emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    },

    shouldSkipUpdate(workspaceId, workspace) {
      const target = resolveTargetByWorkspaceId(workspaceId);
      if (!target) {
        return false;
      }
      const nextStateKey = descriptorStateKey(workspace);
      if (target.latestDescriptorStateKey === nextStateKey) {
        return true;
      }
      target.latestDescriptorStateKey = nextStateKey;
      return false;
    },

    recordDescriptorState(workspaceId, nextWorkspace) {
      const target = resolveTargetByWorkspaceId(workspaceId);
      if (target && onBranchChanged) {
        const newBranchName = nextWorkspace?.name ?? null;
        if (newBranchName !== target.lastBranchName) {
          onBranchChanged(workspaceId, target.lastBranchName, newBranchName);
        }
      }
      rememberDescriptorState(workspaceId, nextWorkspace);
    },

    handleBranchSnapshot,

    removeForWorkspaceId(workspaceId) {
      const target = resolveTargetByWorkspaceId(workspaceId);
      if (target) {
        removeForCwd(target.cwd);
      }
    },

    removeForCwd,

    dispose() {
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
      watchTargets.clear();
    },
  };
}

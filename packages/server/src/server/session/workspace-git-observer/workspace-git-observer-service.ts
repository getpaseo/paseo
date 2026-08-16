import { resolve } from "node:path";
import type pino from "pino";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitWorkspace,
} from "../../workspace-git-service.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";
import type { WorkspaceGitAddress } from "../../workspace-git-directory.js";

const WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY = "__removed__";

interface WorkspaceGitWatchTarget {
  workspaceIds: Set<string>;
}

interface WorkspaceGitWatchState {
  cwd: string;
  address: WorkspaceGitAddress;
  workspaceGit: WorkspaceGitWorkspace;
  latestDescriptorStateKey: string | null;
  lastBranchName: string | null;
}

export interface WorkspaceGitObserverMetrics {
  watchedDirectoryCount: number;
  workspaceRecordCount: number;
  subscriptionCount: number;
}

/**
 * Observes a workspace's git state on disk (via WorkspaceGitService) and drives the
 * live update fan-out: branch-change notifications, workspace-card refreshes, and
 * checkout status updates. It owns the per-cwd watch targets and the WorkspaceGitService
 * subscription handles. Selected subscriptions are keyed by their bound capability; only
 * explicitly legacy bindings may share cwd fan-out.
 *
 * Branch changes reach `onBranchChanged` from two paths that share `lastBranchName`: the
 * on-disk snapshot listener (handleBranchSnapshot) and the workspace-emit loop's Git runtime
 * projection (recordDescriptorState). Both stay inside this module so the shared state is coherent.
 */
export interface WorkspaceGitObserverService {
  syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void;
  syncObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void>;
  warmGitData(workspace: PersistedWorkspaceRecord): Promise<void>;
  // Check-and-record dedupe gate: returns true when the descriptor state is unchanged
  // for this workspace, and otherwise advances the recorded state key as a side effect.
  shouldSkipUpdate(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): boolean;
  recordDescriptorState(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): void;
  handleBranchSnapshot(address: WorkspaceGitAddress, branchName: string | null): void;
  getMetrics(): WorkspaceGitObserverMetrics;
  removeForWorkspaceId(workspaceId: string): void;
  dispose(): void;
}

export function createWorkspaceGitObserverService(deps: {
  resolveWorkspaceGit: (
    workspaceId: string,
    cwd: string,
  ) => { address: WorkspaceGitAddress; workspaceGit: WorkspaceGitWorkspace };
  describeWorkspaceRecordWithGitData: (
    workspace: PersistedWorkspaceRecord,
  ) => Promise<WorkspaceDescriptorPayload>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  emitStatusUpdate: (
    workspaceId: string,
    cwd: string,
    snapshot: WorkspaceGitRuntimeSnapshot,
  ) => void;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  logger: pino.Logger;
}): WorkspaceGitObserverService {
  const {
    resolveWorkspaceGit,
    describeWorkspaceRecordWithGitData,
    emitWorkspaceUpdateForWorkspaceId,
    emitStatusUpdate,
    onBranchChanged,
    logger,
  } = deps;

  const watchTargets = new Map<WorkspaceGitWorkspace, WorkspaceGitWatchTarget>();
  const workspaceStates = new Map<string, WorkspaceGitWatchState>();
  const subscriptions = new Map<WorkspaceGitWorkspace, () => void>();

  function descriptorStateKey(workspace: WorkspaceDescriptorPayload | null): string {
    if (!workspace) {
      return WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY;
    }
    return JSON.stringify([
      workspace.name,
      workspace.diffStat ? [workspace.diffStat.additions, workspace.diffStat.deletions] : null,
    ]);
  }

  function rememberDescriptorState(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    state.latestDescriptorStateKey = descriptorStateKey(workspace);
    const currentBranch = workspace?.gitRuntime?.currentBranch;
    if (currentBranch !== undefined) {
      state.lastBranchName = currentBranch;
    }
  }

  function removeForWorkspaceGit(workspaceGit: WorkspaceGitWorkspace): void {
    const target = watchTargets.get(workspaceGit);
    for (const workspaceId of target?.workspaceIds ?? []) {
      workspaceStates.delete(workspaceId);
    }
    watchTargets.delete(workspaceGit);
    subscriptions.get(workspaceGit)?.();
    subscriptions.delete(workspaceGit);
  }

  function removeForWorkspaceId(workspaceId: string): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    workspaceStates.delete(workspaceId);
    const target = watchTargets.get(state.workspaceGit);
    target?.workspaceIds.delete(workspaceId);
    if (target?.workspaceIds.size === 0) {
      removeForWorkspaceGit(state.workspaceGit);
    }
  }

  function handleBranchSnapshot(address: WorkspaceGitAddress, branchName: string | null): void {
    const addressedState =
      address.kind === "selected" ? workspaceStates.get(address.workspaceId) : null;
    const target = addressedState ? watchTargets.get(addressedState.workspaceGit) : null;
    const workspaceIds = target
      ? [...target.workspaceIds]
      : [...workspaceStates]
          .filter(
            ([, candidate]) =>
              candidate.address.kind === "legacy" && candidate.cwd === resolve(address.cwd),
          )
          .map(([workspaceId]) => workspaceId);
    for (const workspaceId of workspaceIds) {
      const state = workspaceStates.get(workspaceId);
      if (!state) {
        continue;
      }
      const previousBranchName = state.lastBranchName;
      if (branchName === previousBranchName) {
        continue;
      }
      state.lastBranchName = branchName;
      onBranchChanged?.(workspaceId, previousBranchName, branchName);
    }
  }

  function syncObserver(cwd: string, options: { isGit: boolean; workspaceId: string }): void {
    const normalizedCwd = resolve(cwd);
    const { address, workspaceGit } = resolveWorkspaceGit(options.workspaceId, normalizedCwd);
    const currentState = workspaceStates.get(options.workspaceId);
    if (
      currentState &&
      (currentState.cwd !== normalizedCwd || currentState.workspaceGit !== workspaceGit)
    ) {
      removeForWorkspaceId(options.workspaceId);
    }
    if (!options.isGit) {
      removeForWorkspaceId(options.workspaceId);
      return;
    }

    const target = watchTargets.get(workspaceGit) ?? {
      workspaceIds: new Set<string>(),
    };
    watchTargets.set(workspaceGit, target);
    target.workspaceIds.add(options.workspaceId);
    if (!workspaceStates.has(options.workspaceId)) {
      workspaceStates.set(options.workspaceId, {
        cwd: normalizedCwd,
        address,
        workspaceGit,
        latestDescriptorStateKey: null,
        lastBranchName: null,
      });
    }

    if (subscriptions.has(workspaceGit)) {
      return;
    }

    let subscription: ReturnType<WorkspaceGitWorkspace["register"]>;
    try {
      subscription = workspaceGit.register((snapshot) => {
        handleBranchSnapshot(address, snapshot.git.currentBranch ?? null);
        for (const workspaceId of target.workspaceIds) {
          void emitWorkspaceUpdateForWorkspaceId(workspaceId).catch((error) => {
            logger.warn(
              { err: error, cwd: normalizedCwd, workspaceId },
              "Failed to emit workspace update after git branch snapshot",
            );
          });
          emitStatusUpdate(workspaceId, normalizedCwd, snapshot);
        }
      });
    } catch (error) {
      removeForWorkspaceId(options.workspaceId);
      throw error;
    }
    subscriptions.set(workspaceGit, subscription.unsubscribe);
  }

  function syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void {
    for (const workspace of workspaces) {
      syncObserver(workspace.workspaceDirectory, {
        isGit: workspace.workspaceKind !== "directory",
        workspaceId: workspace.id,
      });
      rememberDescriptorState(workspace.id, workspace);
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
      const state = workspaceStates.get(workspaceId);
      if (!state) {
        return false;
      }
      const nextStateKey = descriptorStateKey(workspace);
      if (state.latestDescriptorStateKey === nextStateKey) {
        return true;
      }
      state.latestDescriptorStateKey = nextStateKey;
      return false;
    },

    recordDescriptorState(workspaceId, nextWorkspace) {
      const state = workspaceStates.get(workspaceId);
      const newBranchName = nextWorkspace?.gitRuntime?.currentBranch;
      if (state && onBranchChanged && newBranchName !== undefined) {
        if (newBranchName !== state.lastBranchName) {
          onBranchChanged(workspaceId, state.lastBranchName, newBranchName);
        }
      }
      rememberDescriptorState(workspaceId, nextWorkspace);
    },

    handleBranchSnapshot,

    getMetrics() {
      return {
        watchedDirectoryCount: watchTargets.size,
        workspaceRecordCount: workspaceStates.size,
        subscriptionCount: subscriptions.size,
      };
    },

    removeForWorkspaceId,

    dispose() {
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
      watchTargets.clear();
      workspaceStates.clear();
    },
  };
}

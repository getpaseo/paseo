import { resolve } from "node:path";
import type pino from "pino";
import { PASEO_CONFIG_FILE_NAME } from "../../../utils/paseo-config-file.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";

interface WorkspaceGitWatchTarget {
  workspaceIds: Set<string>;
}

interface WorkspaceGitWatchState {
  cwd: string;
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
 * subscription handles. Filesystem subscriptions are keyed by cwd while descriptor and
 * branch state remain keyed by workspace id, so same-directory workspace records share one
 * watch without sharing identity or teardown lifetime.
 *
 * Branch changes reach `onBranchChanged` from two paths that share `lastBranchName`: the
 * on-disk snapshot listener (handleBranchSnapshot) and the workspace-emit loop's Git runtime
 * projection (recordDescriptorState). Both stay inside this module so the shared state is coherent.
 *
 * Every workspace, Git or not, also watches its paseo.json and refreshes its workspace cards on
 * change, so the Scripts menu follows edits made outside Paseo.
 */
export interface WorkspaceGitObserverService {
  syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void;
  reconcileObservers(
    workspaces: Iterable<
      Pick<WorkspaceDescriptorPayload, "id" | "workspaceDirectory" | "workspaceKind">
    >,
  ): void;
  recordDescriptorState(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): void;
  handleBranchSnapshot(cwd: string, branchName: string | null): void;
  getMetrics(): WorkspaceGitObserverMetrics;
  removeForWorkspaceId(workspaceId: string): void;
  dispose(): void;
}

export function createWorkspaceGitObserverService(deps: {
  workspaceGitService: Pick<WorkspaceGitService, "registerWorkspace">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitStatusUpdate: (cwd: string, snapshot: WorkspaceGitRuntimeSnapshot) => void;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  configObserver?: Pick<FileObserver, "subscribe">;
  logger: pino.Logger;
}): WorkspaceGitObserverService {
  const {
    workspaceGitService,
    emitWorkspaceUpdateForCwd,
    emitStatusUpdate,
    onBranchChanged,
    configObserver = workspaceFileObserver,
    logger,
  } = deps;

  const watchTargets = new Map<string, WorkspaceGitWatchTarget>();
  const workspaceStates = new Map<string, WorkspaceGitWatchState>();
  const subscriptions = new Map<string, () => void>();
  const configWatches = new Map<string, { workspaceIds: Set<string>; release: () => void }>();
  const configCwds = new Map<string, string>();

  function observeConfig(cwd: string, workspaceId: string): void {
    const currentCwd = configCwds.get(workspaceId);
    if (currentCwd === cwd) return;
    if (currentCwd !== undefined) unobserveConfig(workspaceId);
    configCwds.set(workspaceId, cwd);
    const existing = configWatches.get(cwd);
    if (existing) {
      existing.workspaceIds.add(workspaceId);
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let released = false;
    configWatches.set(cwd, {
      workspaceIds: new Set([workspaceId]),
      release: () => {
        released = true;
        unsubscribe?.();
      },
    });
    const refresh = () => {
      void emitWorkspaceUpdateForCwd(cwd).catch((error) => {
        logger.warn({ err: error, cwd }, "Failed to emit workspace update after paseo.json change");
      });
    };
    void (async () => {
      try {
        const subscription = await configObserver.subscribe(
          { cwd, path: PASEO_CONFIG_FILE_NAME },
          refresh,
        );
        if (released) {
          subscription.unsubscribe();
          return;
        }
        unsubscribe = subscription.unsubscribe;
        // Catch an edit made between the client's snapshot and the watch starting.
        // shortcut: a removal in that window stays stale until the next edit; drop the check if that matters.
        if (subscription.initial.status !== "missing") refresh();
      } catch (error) {
        logger.warn({ err: error, cwd }, "Failed to observe paseo.json");
      }
    })();
  }

  function unobserveConfig(workspaceId: string): void {
    const cwd = configCwds.get(workspaceId);
    if (cwd === undefined) return;
    configCwds.delete(workspaceId);
    const watch = configWatches.get(cwd);
    watch?.workspaceIds.delete(workspaceId);
    if (watch?.workspaceIds.size === 0) {
      configWatches.delete(cwd);
      watch.release();
    }
  }

  function rememberDescriptorState(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    const currentBranch = workspace?.gitRuntime?.currentBranch;
    if (currentBranch !== undefined) {
      state.lastBranchName = currentBranch;
    }
  }

  function removeForCwd(cwd: string): void {
    const normalizedCwd = resolve(cwd);
    const target = watchTargets.get(normalizedCwd);
    for (const workspaceId of target?.workspaceIds ?? []) {
      workspaceStates.delete(workspaceId);
    }
    watchTargets.delete(normalizedCwd);
    subscriptions.get(normalizedCwd)?.();
    subscriptions.delete(normalizedCwd);
  }

  function removeGitObservation(workspaceId: string): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    workspaceStates.delete(workspaceId);
    const target = watchTargets.get(state.cwd);
    target?.workspaceIds.delete(workspaceId);
    if (target?.workspaceIds.size === 0) {
      removeForCwd(state.cwd);
    }
  }

  function removeForWorkspaceId(workspaceId: string): void {
    unobserveConfig(workspaceId);
    removeGitObservation(workspaceId);
  }

  function handleBranchSnapshot(cwd: string, branchName: string | null): void {
    const target = watchTargets.get(resolve(cwd));
    if (!target) {
      return;
    }

    for (const workspaceId of target.workspaceIds) {
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
    observeConfig(normalizedCwd, options.workspaceId);
    const currentState = workspaceStates.get(options.workspaceId);
    if (currentState && currentState.cwd !== normalizedCwd) {
      removeGitObservation(options.workspaceId);
    }
    if (!options.isGit) {
      removeGitObservation(options.workspaceId);
      return;
    }

    const target = watchTargets.get(normalizedCwd) ?? {
      workspaceIds: new Set<string>(),
    };
    watchTargets.set(normalizedCwd, target);
    target.workspaceIds.add(options.workspaceId);
    if (!workspaceStates.has(options.workspaceId)) {
      workspaceStates.set(options.workspaceId, {
        cwd: normalizedCwd,
        lastBranchName: null,
      });
    }

    if (subscriptions.has(normalizedCwd)) {
      return;
    }

    let subscription: ReturnType<WorkspaceGitService["registerWorkspace"]>;
    try {
      subscription = workspaceGitService.registerWorkspace({ cwd: normalizedCwd }, (snapshot) => {
        handleBranchSnapshot(normalizedCwd, snapshot.git.currentBranch ?? null);
        void emitWorkspaceUpdateForCwd(normalizedCwd).catch((error) => {
          logger.warn(
            { err: error, cwd: normalizedCwd },
            "Failed to emit workspace update after git branch snapshot",
          );
        });
        emitStatusUpdate(normalizedCwd, snapshot);
      });
    } catch (error) {
      removeGitObservation(options.workspaceId);
      throw error;
    }
    subscriptions.set(normalizedCwd, subscription.unsubscribe);
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

  return {
    reconcileObservers(workspaces) {
      const retained = new Map([...workspaces].map((workspace) => [workspace.id, workspace]));
      for (const workspaceId of new Set([...workspaceStates.keys(), ...configCwds.keys()])) {
        if (!retained.has(workspaceId)) removeForWorkspaceId(workspaceId);
      }
      for (const workspace of retained.values()) {
        syncObserver(workspace.workspaceDirectory, {
          isGit: workspace.workspaceKind !== "directory",
          workspaceId: workspace.id,
        });
      }
    },
    syncObservers,
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
      for (const watch of configWatches.values()) {
        watch.release();
      }
      configWatches.clear();
      configCwds.clear();
    },
  };
}

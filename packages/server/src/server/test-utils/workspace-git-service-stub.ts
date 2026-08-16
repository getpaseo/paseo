import type { CheckoutDiffResult } from "../../utils/checkout-git.js";
import { deriveProjectSlug } from "../workspace-git-metadata.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
  WorkspaceGitWorkspace,
} from "../workspace-git-service.js";

export function createNoGitWorkspaceRuntimeSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: false,
      repoRoot: null,
      mainRepoRoot: null,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: null,
      baseRef: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
    forge: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
    },
  };
}

export function createNoopWorkspaceGitService(
  overrides: Partial<WorkspaceGitService> = {},
): WorkspaceGitService {
  let service!: WorkspaceGitService;
  service = {
    bindWorkspace: ({ cwd }) => bindWorkspaceGitService(service, cwd),
    bindLegacy: (cwd) => bindWorkspaceGitService(service, cwd),
    registerWorkspace: () => ({
      unsubscribe: () => {},
    }),
    onSnapshotUpdated: () => ({
      unsubscribe: () => {},
    }),
    peekSnapshot: () => null,
    getCheckout: async (cwd: string) => ({
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    }),
    getSnapshot: async (cwd: string) => createNoGitWorkspaceRuntimeSnapshot(cwd),
    getCheckoutDiff: async (): Promise<CheckoutDiffResult> => ({ diff: "" }),
    validateBranchRef: async () => ({ kind: "not-found" }),
    hasLocalBranch: async () => false,
    suggestBranchesForCwd: async () => [],
    listStashes: async () => [],
    listWorktrees: async () => [],
    getProjectSlug: async (cwd: string) => {
      const snapshot = createNoGitWorkspaceRuntimeSnapshot(cwd);
      return deriveProjectSlug(cwd, snapshot.git.isGit ? snapshot.git.remoteUrl : null);
    },
    resolveForge: async () => null,
    commit: async () => {},
    discardChanges: async () => {},
    createBranch: async () => {},
    switchBranch: async () => ({ source: "local" }),
    fetch: async () => {},
    listCommits: async () => ({ baseRef: null, commits: [] }),
    getCommitFileDiff: async () => null,
    stashPush: async () => {},
    stashPop: async () => {},
    mergeToBase: async (cwd) => cwd,
    mergeFromBase: async () => {},
    pull: async () => {},
    push: async () => {},
    renameBranch: async (_cwd, branch) => ({ previousBranch: null, currentBranch: branch }),
    resolveRepoRoot: async (cwd: string) => cwd,
    resolveDefaultBranch: async () => "main",
    resolveRepoRemoteUrl: async () => null,
    refresh: async () => {},
    requestWorkingTreeWatch: async () => ({
      repoRoot: null,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    onWorkspaceStateMayHaveChanged: () => {},
    invalidateForge: () => {},
    getMetrics: () => ({
      workspaceTargetCount: 0,
      workspaceListenerCount: 0,
      repositoryTargetCount: 0,
      repositoryWorkspaceLinkCount: 0,
      workingTreeWatchTargetCount: 0,
      workingTreeWatchListenerCount: 0,
      workspaceObservationSetupInFlightCount: 0,
      workingTreeWatchSetupInFlightCount: 0,
      workspaceRefreshInFlightCount: 0,
      workspaceRefreshQueuedCount: 0,
      workspaceRefreshAdmissionActiveCount: 0,
      workspaceRefreshAdmissionPendingCount: 0,
      workspaceObservationSetupAdmissionActiveCount: 0,
      workspaceObservationSetupAdmissionPendingCount: 0,
      fetchInFlightCount: 0,
      snapshotUpdatedListenerCount: 0,
      watcherErrorCallbackCount: 0,
      fileObserver: {
        activeObservationCount: 0,
        nativeHandleCount: 0,
        nativeTrackedFileCount: 0,
        pendingEventCount: 0,
        pendingReconciliationWorkCount: 0,
        reconciliationInFlightCount: 0,
        reconciliationCount: 0,
        scopedReconciliationCount: 0,
        fullReconciliationCount: 0,
        reconciliationFailureCount: 0,
        observerFailureCount: 0,
        directoryLimitFailureCount: 0,
        nativeEventCount: 0,
        nativeChangeEventCount: 0,
        nativeRenameEventCount: 0,
        nativePathlessEventCount: 0,
        nativeClassificationCount: 0,
        nativeShallowScanCount: 0,
        lastReconciliationDurationMs: 0,
        maxReconciliationDurationMs: 0,
      },
    }),
    dispose: async () => {},
    ...overrides,
  };

  return service;
}

export function bindWorkspaceGitService(
  service: WorkspaceGitService,
  cwd: string,
): WorkspaceGitWorkspace {
  return {
    cwd,
    register: (listener) => service.registerWorkspace({ cwd }, listener),
    observe: async (listener) => service.registerWorkspace({ cwd }, listener),
    peekSnapshot: () => service.peekSnapshot(cwd),
    getCheckout: () => service.getCheckout(cwd),
    getSnapshot: (options) =>
      options === undefined ? service.getSnapshot(cwd) : service.getSnapshot(cwd, options),
    resolveForge: () => service.resolveForge(cwd),
    getCheckoutDiff: (options, readOptions) => service.getCheckoutDiff(cwd, options, readOptions),
    validateBranchRef: (ref, options) =>
      options === undefined
        ? service.validateBranchRef(cwd, ref)
        : service.validateBranchRef(cwd, ref, options),
    hasLocalBranch: (branch, options) =>
      options === undefined
        ? service.hasLocalBranch(cwd, branch)
        : service.hasLocalBranch(cwd, branch, options),
    suggestBranches: (options, readOptions) =>
      readOptions === undefined
        ? service.suggestBranchesForCwd(cwd, options)
        : service.suggestBranchesForCwd(cwd, options, readOptions),
    listStashes: (options, readOptions) =>
      readOptions === undefined
        ? service.listStashes(cwd, options)
        : service.listStashes(cwd, options, readOptions),
    listWorktrees: (options) => service.listWorktrees(cwd, options),
    getProjectSlug: (options) => service.getProjectSlug(cwd, options),
    resolveRepoRoot: (options) => service.resolveRepoRoot(cwd, options),
    resolveDefaultBranch: (options) => service.resolveDefaultBranch(cwd, options),
    resolveRepoRemoteUrl: (options) => service.resolveRepoRemoteUrl(cwd, options),
    commit: (options) => service.commit(cwd, options),
    discardChanges: (paths) => service.discardChanges(cwd, paths),
    createBranch: (options) => service.createBranch(cwd, options),
    switchBranch: (branch) => service.switchBranch(cwd, branch),
    fetch: () => service.fetch(cwd),
    listCommits: () => service.listCommits(cwd),
    getCommitFileDiff: (input) => service.getCommitFileDiff(cwd, input),
    stashPush: (message) => service.stashPush(cwd, message),
    stashPop: (stashIndex) => service.stashPop(cwd, stashIndex),
    mergeToBase: (options) => service.mergeToBase(cwd, options),
    mergeFromBase: (options) => service.mergeFromBase(cwd, options),
    pull: () => service.pull(cwd),
    push: () => service.push(cwd),
    renameBranch: (branch) => service.renameBranch(cwd, branch),
    refresh: (options) => service.refresh(cwd, options),
    requestWorkingTreeWatch: (onChange) => service.requestWorkingTreeWatch(cwd, onChange),
    scheduleRefresh: () => service.scheduleRefreshForCwd(cwd),
    stateMayHaveChanged: () => service.onWorkspaceStateMayHaveChanged(cwd),
    invalidateForge: () => service.invalidateForge(cwd),
  };
}

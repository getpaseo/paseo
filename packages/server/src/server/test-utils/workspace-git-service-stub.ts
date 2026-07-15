import type { CheckoutDiffResult } from "../../utils/checkout-git.js";
import { deriveProjectSlug } from "../workspace-git-metadata.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "../workspace-git-service.js";

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
  const service: WorkspaceGitService = {
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
    dispose: () => {},
    ...overrides,
  };

  return service;
}

import { basename } from "node:path";
import type { CheckoutDiffResult } from "../../utils/checkout-git.js";
import {
  buildWorkspaceGitMetadataFromSnapshot,
  type WorkspaceGitMetadata,
} from "../workspace-git-metadata.js";
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
    github: {
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
    peekSnapshot: () => null,
    getSnapshot: async (cwd: string) => createNoGitWorkspaceRuntimeSnapshot(cwd),
    getCheckoutDiff: async (): Promise<CheckoutDiffResult> => ({ diff: "" }),
    validateBranchRef: async () => ({ kind: "not-found" }),
    hasLocalBranch: async () => false,
    suggestBranchesForCwd: async () => [],
    listStashes: async () => [],
    listWorktrees: async () => [],
    getWorkspaceGitMetadata: async (cwd: string, options): Promise<WorkspaceGitMetadata> => {
      const snapshot = createNoGitWorkspaceRuntimeSnapshot(cwd);
      return buildWorkspaceGitMetadataFromSnapshot({
        cwd,
        directoryName: options?.directoryName ?? basename(cwd),
        isGit: snapshot.git.isGit,
        repoRoot: snapshot.git.repoRoot,
        mainRepoRoot: snapshot.git.mainRepoRoot,
        currentBranch: snapshot.git.currentBranch,
        remoteUrl: snapshot.git.remoteUrl,
      });
    },
    resolveRepoRoot: async (cwd: string) => cwd,
    resolveDefaultBranch: async () => "main",
    resolveRepoRemoteUrl: async () => null,
    refresh: async () => {},
    requestWorkingTreeWatch: async () => ({
      repoRoot: null,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    dispose: () => {},
    ...overrides,
  };

  return service;
}

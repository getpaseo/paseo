import { resolve } from "node:path";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";

import {
  setupAutoArchiveOnMerge,
  type AutoArchiveOnMergeDependencies,
  type AutoArchiveOnMergeOptions,
} from "./index.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

function createSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: "/repo",
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: true,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 0, deletions: 0 },
    },
    forge: {
      featuresEnabled: true,
      authState: "authenticated",
      pullRequest: {
        url: "https://github.com/acme/repo/pull/12",
        title: "Merged",
        state: "merged",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: true,
      },
      error: null,
    },
  };
}

test("fans one PR snapshot out to every workspace attached to its exact cwd", async () => {
  let onSnapshotUpdated: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const snapshot = createSnapshot("/repo/worktree/.");
  const options = {
    logger: { child: () => ({ warn: vi.fn() }) } as unknown as Logger,
    workspaceGitService: {
      onSnapshotUpdated: (listener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        onSnapshotUpdated = listener;
        return { unsubscribe: vi.fn() };
      },
    },
    listActiveWorkspaces: async () => [
      { workspaceId: "workspace-a", cwd: "/repo/worktree" },
      { workspaceId: "workspace-b", cwd: "/repo/worktree/child/.." },
      { workspaceId: "workspace-other", cwd: "/repo/other" },
    ],
  } as unknown as AutoArchiveOnMergeOptions;
  const calls: Array<{ workspaceId: string; pullRequest: unknown }> = [];
  let resolveFinished: (() => void) | null = null;
  const finished = new Promise<void>((resolvePromise) => {
    resolveFinished = resolvePromise;
  });
  const deps: AutoArchiveOnMergeDependencies = {
    archiveIfSafe: async (input) => {
      calls.push({ workspaceId: input.workspaceId, pullRequest: input.pullRequest });
      if (calls.length === 2) resolveFinished?.();
    },
    resolvePath: resolve,
  };

  setupAutoArchiveOnMerge(options, deps);
  if (!onSnapshotUpdated) throw new Error("Snapshot listener was not registered");
  onSnapshotUpdated(snapshot);
  await finished;

  expect(calls).toEqual([
    { workspaceId: "workspace-a", pullRequest: snapshot.forge.pullRequest },
    { workspaceId: "workspace-b", pullRequest: snapshot.forge.pullRequest },
  ]);
});

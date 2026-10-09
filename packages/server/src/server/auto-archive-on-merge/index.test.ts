import { resolve } from "node:path";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";

import {
  setupAutoArchiveOnMerge,
  type AutoArchiveOnMergeDependencies,
  type AutoArchiveOnMergeOptions,
} from "./index.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

function createSnapshot(
  cwd: string,
  state: "open" | "merged" = "merged",
): WorkspaceGitRuntimeSnapshot {
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
        title: "Feature",
        state,
        baseRefName: "main",
        headRefName: "feature",
        isMerged: state === "merged",
      },
      error: null,
    },
  };
}

test("fans one fresh observation out to every workspace attached to its exact cwd", async () => {
  let onSnapshotUpdated: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const eventSnapshot = createSnapshot("/repo/worktree/.");
  const freshSnapshot = createSnapshot("/repo/worktree");
  const getSnapshot = vi.fn(async () => freshSnapshot);
  const options = {
    logger: { child: () => ({ warn: vi.fn() }) } as unknown as Logger,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
    workspaceGitService: {
      onSnapshotUpdated: (listener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        onSnapshotUpdated = listener;
        return { unsubscribe: vi.fn() };
      },
      getSnapshot,
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
      calls.push({
        workspaceId: input.workspaceId,
        pullRequest: input.snapshot.forge.pullRequest,
      });
      if (calls.length === 2) resolveFinished?.();
    },
    resolvePath: resolve,
  };

  setupAutoArchiveOnMerge(options, deps);
  if (!onSnapshotUpdated) throw new Error("Snapshot listener was not registered");
  onSnapshotUpdated(createSnapshot("/repo/worktree/.", "open"));
  onSnapshotUpdated(eventSnapshot);
  await finished;

  expect(getSnapshot).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([
    { workspaceId: "workspace-a", pullRequest: freshSnapshot.forge.pullRequest },
    { workspaceId: "workspace-b", pullRequest: freshSnapshot.forge.pullRequest },
  ]);
});

test("serializes the complete fan-out for duplicate merge events on one cwd", async () => {
  let onSnapshotUpdated: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const snapshot = createSnapshot("/repo/worktree/.");
  const options = {
    logger: { child: () => ({ warn: vi.fn() }) } as unknown as Logger,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
    workspaceGitService: {
      onSnapshotUpdated: (listener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        onSnapshotUpdated = listener;
        return { unsubscribe: vi.fn() };
      },
      getSnapshot: async () => snapshot,
    },
    listActiveWorkspaces: async () => [
      { workspaceId: "workspace-a", cwd: "/repo/worktree" },
      { workspaceId: "workspace-b", cwd: "/repo/worktree/child/.." },
    ],
  } as unknown as AutoArchiveOnMergeOptions;
  const archivedWorkspaceIds: string[] = [];
  let releaseFirstArchive: (() => void) | null = null;
  const firstArchivePaused = new Promise<void>((resolvePromise) => {
    releaseFirstArchive = resolvePromise;
  });
  let resolveFinished: (() => void) | null = null;
  const finished = new Promise<void>((resolvePromise) => {
    resolveFinished = resolvePromise;
  });
  const deps: AutoArchiveOnMergeDependencies = {
    archiveIfSafe: async (input) => {
      archivedWorkspaceIds.push(input.workspaceId);
      if (input.workspaceId === "workspace-a") {
        await firstArchivePaused;
      }
      if (archivedWorkspaceIds.length === 2) resolveFinished?.();
    },
    resolvePath: resolve,
  };

  setupAutoArchiveOnMerge(options, deps);
  if (!onSnapshotUpdated) throw new Error("Snapshot listener was not registered");
  onSnapshotUpdated(createSnapshot("/repo/worktree/.", "open"));
  onSnapshotUpdated(snapshot);
  await vi.waitFor(() => expect(archivedWorkspaceIds).toEqual(["workspace-a"]));

  onSnapshotUpdated(createSnapshot("/repo/worktree/child/.."));
  await Promise.resolve();
  expect(archivedWorkspaceIds).toEqual(["workspace-a"]);

  releaseFirstArchive?.();
  await finished;
  expect(archivedWorkspaceIds).toEqual(["workspace-a", "workspace-b"]);
});

test("does not fan out a stale merged event when the fresh observation has no PR", async () => {
  let onSnapshotUpdated: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const eventSnapshot = createSnapshot("/repo/worktree");
  const freshSnapshot = createSnapshot("/repo/worktree");
  freshSnapshot.forge.pullRequest = null;
  const archiveIfSafe = vi.fn();
  const getSnapshot = vi.fn(async () => freshSnapshot);
  const options = {
    logger: { child: () => ({ warn: vi.fn() }) } as unknown as Logger,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
    workspaceGitService: {
      onSnapshotUpdated: (listener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        onSnapshotUpdated = listener;
        return { unsubscribe: vi.fn() };
      },
      getSnapshot,
    },
    listActiveWorkspaces: vi.fn(async () => [
      { workspaceId: "workspace-a", cwd: "/repo/worktree" },
    ]),
  } as unknown as AutoArchiveOnMergeOptions;

  setupAutoArchiveOnMerge(options, { archiveIfSafe, resolvePath: resolve });
  if (!onSnapshotUpdated) throw new Error("Snapshot listener was not registered");
  onSnapshotUpdated(createSnapshot("/repo/worktree", "open"));
  onSnapshotUpdated(eventSnapshot);
  await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(archiveIfSafe).not.toHaveBeenCalled();
  expect(options.listActiveWorkspaces).not.toHaveBeenCalled();
});

test("logs and skips when the fresh observation cannot be read", async () => {
  let onSnapshotUpdated: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const warn = vi.fn();
  const archiveIfSafe = vi.fn();
  const options = {
    logger: { child: () => ({ warn }) } as unknown as Logger,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
    workspaceGitService: {
      onSnapshotUpdated: (listener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        onSnapshotUpdated = listener;
        return { unsubscribe: vi.fn() };
      },
      getSnapshot: async () => {
        throw new Error("snapshot failed");
      },
    },
    listActiveWorkspaces: vi.fn(),
  } as unknown as AutoArchiveOnMergeOptions;

  setupAutoArchiveOnMerge(options, { archiveIfSafe, resolvePath: resolve });
  if (!onSnapshotUpdated) throw new Error("Snapshot listener was not registered");
  onSnapshotUpdated(createSnapshot("/repo/worktree", "open"));
  onSnapshotUpdated(createSnapshot("/repo/worktree"));
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), cwd: "/repo/worktree" },
      "Failed to read snapshot for auto-archive; skipping",
    ),
  );
  expect(archiveIfSafe).not.toHaveBeenCalled();
  expect(options.listActiveWorkspaces).not.toHaveBeenCalled();
});

test("does not read an observation when auto-archive is disabled", async () => {
  let onSnapshotUpdated: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const getSnapshot = vi.fn();
  const archiveIfSafe = vi.fn();
  const options = {
    logger: { child: () => ({ warn: vi.fn() }) } as unknown as Logger,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: false }) },
    workspaceGitService: {
      onSnapshotUpdated: (listener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        onSnapshotUpdated = listener;
        return { unsubscribe: vi.fn() };
      },
      getSnapshot,
    },
    listActiveWorkspaces: vi.fn(),
  } as unknown as AutoArchiveOnMergeOptions;

  setupAutoArchiveOnMerge(options, { archiveIfSafe, resolvePath: resolve });
  if (!onSnapshotUpdated) throw new Error("Snapshot listener was not registered");
  onSnapshotUpdated(createSnapshot("/repo/worktree"));
  expect(getSnapshot).not.toHaveBeenCalled();
  expect(archiveIfSafe).not.toHaveBeenCalled();
});

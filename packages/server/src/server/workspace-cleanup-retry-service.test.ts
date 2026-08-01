import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  findWorkspaceCleanupRetryTargets,
  WorkspaceCleanupRetryService,
} from "./workspace-cleanup-retry-service.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

afterEach(() => {
  vi.useRealTimers();
});

function pendingWorkspace(input: {
  workspaceId: string;
  directoryPath: string;
  incarnationId: string | null;
  archived?: boolean;
}) {
  const timestamp = "2026-07-31T00:00:00.000Z";
  return createPersistedWorkspaceRecord({
    workspaceId: input.workspaceId,
    projectId: "project-cleanup-retry",
    cwd: input.directoryPath,
    kind: "worktree",
    displayName: input.workspaceId,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: input.archived === false ? null : timestamp,
    cleanupPending: {
      directoryPath: input.directoryPath,
      teardownCwd: input.directoryPath,
      mainRepoRoot: "/repo",
      paseoWorktreesRoot: "/worktrees",
      worktreeIncarnationId: input.incarnationId,
    },
  });
}

test("groups archived cleanup by directory and requires one verified incarnation", () => {
  const targets = findWorkspaceCleanupRetryTargets([
    pendingWorkspace({
      workspaceId: "ws-a",
      directoryPath: "/worktrees/shared",
      incarnationId: "inc-shared",
    }),
    pendingWorkspace({
      workspaceId: "ws-b",
      directoryPath: "/worktrees/shared",
      incarnationId: "inc-shared",
    }),
    pendingWorkspace({
      workspaceId: "ws-legacy",
      directoryPath: "/worktrees/legacy",
      incarnationId: null,
    }),
    pendingWorkspace({
      workspaceId: "ws-conflict-a",
      directoryPath: "/worktrees/conflict",
      incarnationId: "inc-a",
    }),
    pendingWorkspace({
      workspaceId: "ws-conflict-b",
      directoryPath: "/worktrees/conflict",
      incarnationId: "inc-b",
    }),
    pendingWorkspace({
      workspaceId: "ws-active",
      directoryPath: "/worktrees/active",
      incarnationId: "inc-active",
      archived: false,
    }),
  ]);

  expect(targets).toEqual([
    {
      directoryPath: "/worktrees/shared",
      worktreeIncarnationId: "inc-shared",
      workspaceIds: ["ws-a", "ws-b"],
    },
  ]);
});

test("rotates bounded batches and preserves backoff after a failed target", async () => {
  vi.useFakeTimers();
  const workspaces = [
    pendingWorkspace({
      workspaceId: "ws-first",
      directoryPath: "/worktrees/first",
      incarnationId: "inc-first",
    }),
    pendingWorkspace({
      workspaceId: "ws-second",
      directoryPath: "/worktrees/second",
      incarnationId: "inc-second",
    }),
  ];
  const attempts: string[] = [];
  const retryWorktreeCleanup = vi.fn(async ({ directoryPath: targetPath }) => {
    attempts.push(targetPath);
    if (targetPath === "/worktrees/first") throw new Error("still busy");
  });
  const service = new WorkspaceCleanupRetryService({
    workspaceRegistry: {
      list: async () => workspaces,
      subscribeToMutations: () => () => undefined,
    },
    retryWorktreeCleanup,
    logger: createTestLogger(),
    retryBaseMs: 10,
    retryMaxMs: 10,
    idlePollMs: 100,
    maxTargetsPerCycle: 1,
  });

  await service.start();
  await vi.advanceTimersToNextTimerAsync();
  expect(attempts).toEqual(["/worktrees/first"]);

  await vi.advanceTimersByTimeAsync(9);
  expect(attempts).toEqual(["/worktrees/first"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts).toContain("/worktrees/second");

  await vi.advanceTimersToNextTimerAsync();
  expect(attempts.filter((path) => path === "/worktrees/first")).toHaveLength(2);

  await service.stop();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(retryWorktreeCleanup).toHaveBeenCalledTimes(attempts.length);
});

test("shutdown joins canceled cleanup through process closure and releases once", async () => {
  vi.useFakeTimers();
  let abortCount = 0;
  let closeProcess = () => {};
  const processClosed = new Promise<void>((resolve) => {
    closeProcess = resolve;
  });
  const rejectAfterProcessClose = (reject: (error: Error) => void) =>
    processClosed.then(() => {
      reject(new Error("cleanup canceled after process close"));
      return undefined;
    });
  const releaseSubscription = vi.fn();
  const retryWorktreeCleanup = vi.fn((_target, signal: AbortSignal) => {
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          abortCount += 1;
          void rejectAfterProcessClose(reject);
        },
        { once: true },
      );
    });
  });
  const service = new WorkspaceCleanupRetryService({
    workspaceRegistry: {
      list: async () => [
        pendingWorkspace({
          workspaceId: "ws-hung",
          directoryPath: "/worktrees/hung",
          incarnationId: "inc-hung",
        }),
      ],
      subscribeToMutations: () => releaseSubscription,
    },
    retryWorktreeCleanup,
    logger: createTestLogger(),
  });

  await expect(service.start()).resolves.toBeUndefined();
  await vi.advanceTimersToNextTimerAsync();
  expect(retryWorktreeCleanup).toHaveBeenCalledTimes(1);

  let stopSettled = false;
  const stopping = service.stop().then(() => {
    stopSettled = true;
    return undefined;
  });
  await Promise.resolve();

  expect(abortCount).toBe(1);
  expect(stopSettled).toBe(false);
  expect(releaseSubscription).toHaveBeenCalledOnce();

  closeProcess();
  await expect(stopping).resolves.toBeUndefined();
  expect(stopSettled).toBe(true);

  await expect(service.stop()).resolves.toBeUndefined();
  expect(abortCount).toBe(1);
  expect(releaseSubscription).toHaveBeenCalledOnce();
});

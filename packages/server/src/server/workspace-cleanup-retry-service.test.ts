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

test("bounds each retry cycle and cancels the scheduled backoff on stop", async () => {
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
  const retryWorktreeCleanup = vi.fn(async () => {
    throw new Error("still busy");
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
  expect(retryWorktreeCleanup).toHaveBeenCalledTimes(1);

  await service.stop();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(retryWorktreeCleanup).toHaveBeenCalledTimes(1);
});

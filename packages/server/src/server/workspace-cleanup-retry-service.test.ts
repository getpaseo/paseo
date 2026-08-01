import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  type CleanupRetryTarget,
  WorkspaceCleanupRetryService,
} from "./workspace-cleanup-retry-service.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";

afterEach(() => {
  vi.useRealTimers();
});

function cleanupWorkspace(input: {
  workspaceId: string;
  backingPath?: string;
  directoryIdentity?: string | null;
  worktreeIncarnationId?: string;
  quarantineMarker?: string;
  createdAt?: string;
  lastAttemptAt?: string | null;
  attemptCount?: number;
  archived?: boolean;
}): PersistedWorkspaceRecord {
  const createdAt = input.createdAt ?? "2026-08-01T00:00:00.000Z";
  const backingPath = input.backingPath ?? `/tmp/${input.workspaceId}`;
  return createPersistedWorkspaceRecord({
    workspaceId: input.workspaceId,
    projectId: "project-one",
    cwd: backingPath,
    kind: "worktree",
    displayName: input.workspaceId,
    createdAt,
    updatedAt: createdAt,
    archivedAt: input.archived === false ? null : createdAt,
    cleanupPending: {
      workspaceId: input.workspaceId,
      backingPath,
      teardownCwds: [backingPath],
      mainRepoRoot: "/tmp/repo",
      paseoWorktreesRoot: "/tmp/paseo/worktrees/repo",
      directoryIdentity: input.directoryIdentity ?? "1:42",
      worktreeIncarnationId: input.worktreeIncarnationId,
      quarantineMarker: input.quarantineMarker,
      createdAt,
      lastAttemptAt: input.lastAttemptAt ?? null,
      attemptCount: input.attemptCount ?? 0,
      lastError: null,
    },
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("WorkspaceCleanupRetryService", () => {
  test("deduplicates cleanup ownership and bounds each retry cycle", async () => {
    const retryWorkspaceCleanup = vi.fn(async () => undefined);
    const service = new WorkspaceCleanupRetryService({
      workspaceRegistry: {
        list: async () => [
          cleanupWorkspace({
            workspaceId: "shared-newer",
            backingPath: "/tmp/.paseo-cleanup-shared",
            worktreeIncarnationId: "00000000-0000-4000-8000-000000000042",
            createdAt: "2026-08-01T00:00:01.000Z",
          }),
          cleanupWorkspace({
            workspaceId: "shared-owner",
            backingPath: "/tmp/shared",
            worktreeIncarnationId: "00000000-0000-4000-8000-000000000042",
            createdAt: "2026-08-01T00:00:00.000Z",
          }),
          cleanupWorkspace({
            workspaceId: "second",
            createdAt: "2026-08-01T00:00:02.000Z",
          }),
          cleanupWorkspace({
            workspaceId: "third",
            createdAt: "2026-08-01T00:00:03.000Z",
          }),
          cleanupWorkspace({ workspaceId: "active", archived: false }),
        ],
      },
      retryWorkspaceCleanup,
      logger: createTestLogger(),
      maxAttemptsPerCycle: 2,
    });

    await service.runNow();

    expect(retryWorkspaceCleanup.mock.calls.map(([target]) => target.workspaceId)).toEqual([
      "shared-owner",
      "second",
    ]);
  });

  test("retries only receipts whose exponential delay has elapsed", async () => {
    const retryWorkspaceCleanup = vi.fn(async () => undefined);
    const service = new WorkspaceCleanupRetryService({
      workspaceRegistry: {
        list: async () => [
          cleanupWorkspace({
            workspaceId: "due",
            lastAttemptAt: "2026-08-01T00:00:00.000Z",
            attemptCount: 3,
          }),
          cleanupWorkspace({
            workspaceId: "not-due",
            lastAttemptAt: "2026-08-01T00:00:01.000Z",
            attemptCount: 3,
          }),
          cleanupWorkspace({
            workspaceId: "never-attempted",
            lastAttemptAt: "2026-08-01T00:00:19.999Z",
            attemptCount: 0,
          }),
        ],
      },
      retryWorkspaceCleanup,
      logger: createTestLogger(),
      retryDelayMs: 5_000,
      now: () => new Date("2026-08-01T00:00:20.000Z"),
    });

    await service.runNow();

    expect(retryWorkspaceCleanup.mock.calls.map(([target]) => target.workspaceId)).toEqual([
      "due",
      "never-attempted",
    ]);
  });

  test("does not combine cleanup receipts with different quarantine markers", async () => {
    const retryWorkspaceCleanup = vi.fn(async () => undefined);
    const incarnationId = "00000000-0000-4000-8000-000000000042";
    const service = new WorkspaceCleanupRetryService({
      workspaceRegistry: {
        list: async () => [
          cleanupWorkspace({
            workspaceId: "first",
            worktreeIncarnationId: incarnationId,
            quarantineMarker: "00000000-0000-4000-8000-000000000043",
          }),
          cleanupWorkspace({
            workspaceId: "second",
            worktreeIncarnationId: incarnationId,
            quarantineMarker: "00000000-0000-4000-8000-000000000044",
          }),
        ],
      },
      retryWorkspaceCleanup,
      logger: createTestLogger(),
    });

    await service.runNow();

    expect(retryWorkspaceCleanup.mock.calls.map(([target]) => target.workspaceId)).toEqual([
      "first",
      "second",
    ]);
  });

  test("runs at startup and on the polling interval until stopped", async () => {
    vi.useFakeTimers();
    const retryWorkspaceCleanup = vi.fn(async () => undefined);
    const service = new WorkspaceCleanupRetryService({
      workspaceRegistry: { list: async () => [cleanupWorkspace({ workspaceId: "pending" })] },
      retryWorkspaceCleanup,
      logger: createTestLogger(),
      pollIntervalMs: 100,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(retryWorkspaceCleanup).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(retryWorkspaceCleanup).toHaveBeenCalledTimes(2);

    await service.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(retryWorkspaceCleanup).toHaveBeenCalledTimes(2);
  });

  test("coalesces overlapping cycles and waits for the active cleanup during shutdown", async () => {
    let finishCleanup = () => undefined;
    const cleanupFinished = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanupStarted = Promise.withResolvers<void>();
    const retryWorkspaceCleanup = vi.fn(() => {
      cleanupStarted.resolve();
      return cleanupFinished;
    });
    const service = new WorkspaceCleanupRetryService({
      workspaceRegistry: { list: async () => [cleanupWorkspace({ workspaceId: "pending" })] },
      retryWorkspaceCleanup,
      logger: createTestLogger(),
    });

    const firstCycle = service.runNow();
    const overlappingCycle = service.runNow();
    await cleanupStarted.promise;
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
      return undefined;
    });
    expect(retryWorkspaceCleanup).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false);

    finishCleanup();
    await Promise.all([firstCycle, overlappingCycle, stopping]);
    expect(stopped).toBe(true);
  });

  test("aborts the active cleanup during shutdown", async () => {
    const cleanupStarted = Promise.withResolvers<AbortSignal>();
    const retryWorkspaceCleanup = vi.fn(
      async (_target: CleanupRetryTarget, signal: AbortSignal) => {
        cleanupStarted.resolve(signal);
        await waitForAbort(signal);
      },
    );
    const service = new WorkspaceCleanupRetryService({
      workspaceRegistry: { list: async () => [cleanupWorkspace({ workspaceId: "pending" })] },
      retryWorkspaceCleanup,
      logger: createTestLogger(),
    });

    const cycle = service.runNow();
    const signal = await cleanupStarted.promise;
    await service.stop();
    await cycle;

    expect(signal.aborted).toBe(true);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { FileBackedWorkspaceLifecycleOperationStore } from "./workspace-lifecycle-operation-store.js";
import {
  PaseoWorkspaceLifecycleOperationService,
  WorkspaceLifecycleManualCleanupError,
  fingerprintWorkspaceLifecycleRequest,
} from "./workspace-lifecycle-operation-service.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createService(options?: { allowDestructiveMutation?: boolean }) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-lifecycle-service-"));
  cleanupPaths.push(root);
  const store = new FileBackedWorkspaceLifecycleOperationStore({
    filePath: path.join(root, "workspace-lifecycle-operations.json"),
    logger: createTestLogger(),
  });
  return {
    store,
    service: new PaseoWorkspaceLifecycleOperationService({
      store,
      logger: createTestLogger(),
      allowDestructiveMutation: options?.allowDestructiveMutation ?? true,
    }),
  };
}

describe("PaseoWorkspaceLifecycleOperationService", () => {
  test("replays one committed create result without creating a replacement", async () => {
    const { service } = createService();
    const create = vi.fn(async () => ({ workspaceId: "wks_created" }));
    const input = {
      operationId: "create-request",
      fingerprint: fingerprintWorkspaceLifecycleRequest({ cwd: "C:/repo", slug: "feature" }),
      resourceKey: "worktree:C:/repo/feature",
      create,
    };

    await expect(service.runCreate(input)).resolves.toEqual({ workspaceId: "wks_created" });
    await expect(service.runCreate(input)).resolves.toEqual({ workspaceId: "wks_created" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("rejects replay with a conflicting request fingerprint", async () => {
    const { service } = createService();
    await service.runCreate({
      operationId: "create-conflict",
      fingerprint: "fingerprint-a",
      resourceKey: "worktree:C:/repo/conflict",
      create: async () => ({ workspaceId: "wks_conflict" }),
    });

    await expect(
      service.runCreate({
        operationId: "create-conflict",
        fingerprint: "fingerprint-b",
        resourceKey: "worktree:C:/repo/conflict",
        create: async () => ({ workspaceId: "replacement" }),
      }),
    ).rejects.toThrow(/fingerprint|conflict/i);
  });

  test("waits for shared admissions before entering destructive mutation", async () => {
    const { service } = createService();
    let releaseReader!: () => void;
    const reader = service.withSharedAdmission(
      { resourceKey: "workspace:wks_lease", actor: "agent" },
      async () => new Promise<void>((resolve) => (releaseReader = resolve)),
    );
    await Promise.resolve();
    const mutate = vi.fn(async () => ({ removedDirectory: true }));
    const removal = service.runRemoval({
      operationId: "archive-lease",
      fingerprint: "archive-fingerprint",
      resourceKey: "workspace:wks_lease",
      quiesce: async () => {},
      verify: async () => true,
      mutate,
    });

    await Promise.resolve();
    expect(mutate).not.toHaveBeenCalled();
    releaseReader();
    await reader;
    await expect(removal).resolves.toEqual({ removedDirectory: true });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  test("records MANUAL_CLEANUP and preserves the resource when quiescence fails", async () => {
    const { service, store } = createService();
    const mutate = vi.fn(async () => ({ removedDirectory: true }));
    await expect(
      service.runRemoval({
        operationId: "archive-quiescence",
        fingerprint: "archive-fingerprint",
        resourceKey: "workspace:wks_quiescence",
        quiesce: async () => {
          throw new Error("terminal refused to stop");
        },
        verify: async () => true,
        mutate,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLifecycleManualCleanupError);
    expect(mutate).not.toHaveBeenCalled();
    expect((await store.get("archive-quiescence"))?.state).toBe("MANUAL_CLEANUP");
  });

  test("keeps live automatic deletion disabled by default", async () => {
    const { service, store } = createService({ allowDestructiveMutation: false });
    const mutate = vi.fn(async () => ({ removedDirectory: true }));
    await expect(
      service.runRemoval({
        operationId: "archive-disabled",
        fingerprint: "archive-fingerprint",
        resourceKey: "workspace:wks_disabled",
        quiesce: async () => {},
        verify: async () => true,
        mutate,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLifecycleManualCleanupError);
    expect(mutate).not.toHaveBeenCalled();
    expect((await store.get("archive-disabled"))?.state).toBe("MANUAL_CLEANUP");
  });

  test("startup recovery claims interrupted operations without creating replacements", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-lifecycle-restart-"));
    cleanupPaths.push(root);
    const filePath = path.join(root, "workspace-lifecycle-operations.json");
    const crashedStore = new FileBackedWorkspaceLifecycleOperationStore({
      filePath,
      logger: createTestLogger(),
    });
    const reserved = await crashedStore.reserve({
      operationId: "interrupted-archive",
      kind: "archive",
      fingerprint: "interrupted-fingerprint",
      resourceKey: "worktree:C:/repo/interrupted",
    });
    await crashedStore.compareAndTransition({
      operationId: reserved.record.operationId,
      expectedVersion: reserved.record.version,
      expectedState: "PREPARED",
      expectedFence: reserved.record.fence,
      nextState: "ADMISSION_CLOSED",
    });

    const restartedStore = new FileBackedWorkspaceLifecycleOperationStore({
      filePath,
      logger: createTestLogger(),
    });
    const restartedService = new PaseoWorkspaceLifecycleOperationService({
      store: restartedStore,
      logger: createTestLogger(),
    });
    const recovered = await restartedService.recoverInterruptedOperations();

    expect(recovered).toHaveLength(1);
    const record = await restartedStore.get("interrupted-archive");
    expect(record?.state).toBe("MANUAL_CLEANUP");
    expect(record?.claimedBy).toBe("startup-recovery");
    expect(record?.evidence).toContain("ADMISSION_CLOSED");
    expect(await restartedStore.listNonterminal()).toEqual([]);

    // The claimed record frees the resource for an explicit new request.
    const retried = await restartedStore.reserve({
      operationId: "interrupted-archive-retry",
      kind: "archive",
      fingerprint: "retry-fingerprint",
      resourceKey: "worktree:C:/repo/interrupted",
    });
    expect(retried.kind).toBe("created");
    expect(retried.record.generation).toBe(2);
  });
});

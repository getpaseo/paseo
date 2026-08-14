import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  FileBackedWorkspaceLifecycleOperationStore,
  WorkspaceLifecycleOperationConflictError,
} from "./workspace-lifecycle-operation-store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createStore() {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-lifecycle-store-"));
  cleanupPaths.push(root);
  const filePath = path.join(root, "workspace-lifecycle-operations.json");
  return {
    filePath,
    store: new FileBackedWorkspaceLifecycleOperationStore({
      filePath,
      logger: createTestLogger(),
    }),
  };
}

describe("FileBackedWorkspaceLifecycleOperationStore", () => {
  test("replays the same operation and rejects a conflicting fingerprint", async () => {
    const { store } = createStore();
    const first = await store.reserve({
      operationId: "request-1",
      kind: "create",
      fingerprint: "fingerprint-a",
      resourceKey: "worktree:repo/feature",
    });
    const replay = await store.reserve({
      operationId: "request-1",
      kind: "create",
      fingerprint: "fingerprint-a",
      resourceKey: "worktree:repo/feature",
    });

    expect(first.kind).toBe("created");
    expect(replay).toEqual({ kind: "replay", record: first.record });
    await expect(
      store.reserve({
        operationId: "request-1",
        kind: "create",
        fingerprint: "fingerprint-b",
        resourceKey: "worktree:repo/feature",
      }),
    ).rejects.toBeInstanceOf(WorkspaceLifecycleOperationConflictError);
  });

  test("persists before publishing a compare-and-transition", async () => {
    const { filePath, store } = createStore();
    const reserved = await store.reserve({
      operationId: "request-2",
      kind: "archive",
      fingerprint: "fingerprint",
      resourceKey: "workspace:wks_1",
    });
    const transitioned = await store.compareAndTransition({
      operationId: reserved.record.operationId,
      expectedVersion: reserved.record.version,
      expectedState: "PREPARED",
      expectedFence: reserved.record.fence,
      nextState: "ADMISSION_CLOSED",
    });

    const reopened = new FileBackedWorkspaceLifecycleOperationStore({
      filePath,
      logger: createTestLogger(),
    });
    await reopened.initialize();
    expect(await reopened.get("request-2")).toEqual(transitioned);
  });

  test("rejects a stale fence and preserves the current record", async () => {
    const { store } = createStore();
    const reserved = await store.reserve({
      operationId: "request-3",
      kind: "archive",
      fingerprint: "fingerprint",
      resourceKey: "workspace:wks_2",
    });

    await expect(
      store.compareAndTransition({
        operationId: reserved.record.operationId,
        expectedVersion: reserved.record.version,
        expectedState: "PREPARED",
        expectedFence: reserved.record.fence + 1,
        nextState: "ADMISSION_CLOSED",
      }),
    ).rejects.toThrow(/stale/i);
    expect((await store.get("request-3"))?.state).toBe("PREPARED");
  });

  test("fails closed when the journal is malformed", async () => {
    const { filePath } = createStore();
    writeFileSync(filePath, '{"schemaVersion":"1","operations":[]}', "utf8");
    const reopened = new FileBackedWorkspaceLifecycleOperationStore({
      filePath,
      logger: createTestLogger(),
    });
    await expect(reopened.initialize()).rejects.toThrow();
  });

  test("allows only one nonterminal owner for a resource", async () => {
    const { store } = createStore();
    await store.reserve({
      operationId: "request-owner-a",
      kind: "archive",
      fingerprint: "a",
      resourceKey: "workspace:wks_3",
    });
    await expect(
      store.reserve({
        operationId: "request-owner-b",
        kind: "archive",
        fingerprint: "b",
        resourceKey: "workspace:wks_3",
      }),
    ).rejects.toThrow(/owned|nonterminal|busy/i);
  });
});

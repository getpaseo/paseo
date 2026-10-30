import assert from "node:assert/strict";
import { createHook, executionAsyncResource } from "node:async_hooks";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MessagePort } from "node:worker_threads";
import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { deriveProjectKey } from "../project-key.js";
import { WorkspaceReconciliationService } from "../workspace-reconciliation-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { createTestRegistries, createTestLogger } from "./reconciliation-registries.js";

// Bundle before launch: neither the runner nor a TypeScript loader belongs to
// the measured thread. Keep fixture construction and its garbage outside the
// cold run; GC caused by reconciliation itself remains in the budget.
const rootPath = process.argv[2];
assert.ok(rootPath, "Project root is required");
const timestamp = "2025-01-01T00:00:00.000Z";
const { projects, workspaces, projectRegistry, workspaceRegistry } = createTestRegistries();
projects.set(
  "p1",
  createPersistedProjectRecord({
    projectId: "p1",
    rootPath,
    projectKey: deriveProjectKey({
      rootPath,
      remoteUrl: null,
      worktreeRoot: null,
      mainRepoRoot: null,
    }),
    kind: "non_git",
    displayName: "project",
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
);
for (let i = 0; i < 20000; i++) {
  const workspaceId = `w${i}`;
  workspaces.set(
    workspaceId,
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "p1",
      cwd: path.join(rootPath, workspaceId),
      kind: "directory",
      displayName: workspaceId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
}
const service = new WorkspaceReconciliationService({
  projectRegistry,
  workspaceRegistry,
  logger: createTestLogger(),
});
assert.ok(global.gc, "Launch the probe with --expose-gc");
global.gc();
await nextTurn();
let workerMessages = 0;
const activity = createHook({
  before() {
    if (executionAsyncResource() instanceof MessagePort) workerMessages++;
  },
}).enable();
try {
  const measured = await measureMainThreadWork("workspace reconciliation main-thread work", () =>
    service.runOnce(),
  );
  activity.disable();
  process.stdout.write(
    JSON.stringify({
      blockingMs: measured.blockingMs,
      filesystemRequests: measured.filesystemRequests,
      yields: measured.yields,
      changesAppliedCount: measured.result.changesApplied.length,
      allArchived: [...workspaces.values()].every((workspace) => workspace.archivedAt !== null),
      workerMessages,
    }),
  );
} finally {
  activity.disable();
  service.dispose();
}

import path from "node:path";
import { stat } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { createTestRegistries, createTestLogger } from "./reconciliation-registries.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { WorkspaceReconciliationService } from "../workspace-reconciliation-service.js";
import { deriveProjectKey } from "../project-key.js";

const rootPath = process.argv[2];
if (!rootPath) throw new Error("Project root is required");
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

// Compile before launch and measure in plain Node, outside the test runner's
// thread and TypeScript loader. Keep the first real reconciliation cold.
// Initialize async filesystem support using the bundle, leaving every project
// and workspace path untouched until the first reconciliation.
await stat(process.argv[1]);
await nextTurn();
try {
  const measured = await measureMainThreadWork("workspace reconciliation main-thread work", () =>
    service.runOnce(),
  );
  process.stdout.write(
    JSON.stringify({
      blockingMs: measured.blockingMs,
      filesystemRequests: measured.filesystemRequests,
      changesApplied: measured.result.changesApplied.length,
      allArchived: [...workspaces.values()].every((workspace) => workspace.archivedAt !== null),
    }),
  );
} finally {
  service.dispose();
}

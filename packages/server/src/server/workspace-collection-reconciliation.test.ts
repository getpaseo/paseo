import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { reconcileDanglingWorkspaceCollectionAssignments } from "./workspace-collection-reconciliation.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceCollectionRegistry,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("startup reconciliation clears only collection IDs absent from the catalog", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-collection-reconcile-"));
  temporaryDirectories.push(home);
  const logger = createTestLogger();
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(home, "projects", "workspaces.json"),
    logger,
  );
  const collectionRegistry = new FileBackedWorkspaceCollectionRegistry(
    path.join(home, "projects", "workspace-collections.json"),
    logger,
  );
  await Promise.all([workspaceRegistry.initialize(), collectionRegistry.initialize()]);
  await collectionRegistry.upsert({
    id: "collection-valid",
    name: "Valid",
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:00:00.000Z",
  });
  for (const [workspaceId, collectionId] of [
    ["workspace-valid", "collection-valid"],
    ["workspace-dangling", "collection-missing"],
    ["workspace-unassigned", null],
  ] as const) {
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-1",
        cwd: path.join(home, workspaceId),
        kind: "directory",
        displayName: workspaceId,
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:00:00.000Z",
        collectionId,
      }),
    );
  }

  const repaired = await reconcileDanglingWorkspaceCollectionAssignments({
    workspaceRegistry,
    workspaceCollectionRegistry: collectionRegistry,
    logger,
  });

  expect(repaired).toEqual(["workspace-dangling"]);
  expect((await workspaceRegistry.get("workspace-valid"))?.collectionId).toBe("collection-valid");
  expect((await workspaceRegistry.get("workspace-dangling"))?.collectionId).toBeNull();
  expect((await workspaceRegistry.get("workspace-unassigned"))?.collectionId).toBeNull();
});

import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceCollectionRegistry,
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
} from "./workspace-registry.js";

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let collectionRegistry: FileBackedWorkspaceCollectionRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    collectionRegistry = new FileBackedWorkspaceCollectionRegistry(
      path.join(tmpDir, "projects", "workspace-collections.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("emits one project change after each persisted mutation and ignores no-ops", async () => {
    const projectId = "project-subscriptions";
    const changes: string[] = [];
    const unsubscribe = projectRegistry.subscribeChanges((changedProjectId) => {
      changes.push(changedProjectId);
    });
    const created = createPersistedProjectRecord({
      projectId,
      rootPath: "/tmp/project-subscriptions",
      kind: "git",
      displayName: "project-subscriptions",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-13T08:00:00.000Z",
    });

    await projectRegistry.upsert(created);
    const detachedRead = await projectRegistry.get(projectId);
    expect(detachedRead).not.toBeNull();
    detachedRead!.displayName = "mutated outside registry";
    expect((await projectRegistry.get(projectId))?.displayName).toBe("project-subscriptions");

    await projectRegistry.upsert({
      ...created,
      displayName: "project-refreshed",
      updatedAt: "2026-07-13T08:30:00.000Z",
    });
    await projectRegistry.setCustomName(projectId, "User name", "2026-07-13T09:00:00.000Z");
    await projectRegistry.setCustomName(projectId, "Ignored name", "2026-07-13T09:30:00.000Z", {
      expectedCurrentNames: [null],
    });
    await projectRegistry.archive(projectId, "2026-07-13T10:00:00.000Z");
    await projectRegistry.unarchive(projectId, "2026-07-13T10:30:00.000Z");
    await projectRegistry.remove(projectId);
    await projectRegistry.remove(projectId);

    expect(changes).toEqual(Array.from({ length: 6 }, () => projectId));

    unsubscribe();
    await projectRegistry.upsert(created);
    expect(changes).toHaveLength(6);
  });

  test("persists workspace pin and collection organization without changing activity dates", async () => {
    await workspaceRegistry.initialize();
    await collectionRegistry.initialize();
    const createdAt = "2026-07-13T08:00:00.000Z";
    const updatedAt = "2026-07-13T08:30:00.000Z";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-organized",
        projectId: "project-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt,
        updatedAt,
      }),
    );
    const collection = {
      id: "wsc-focus",
      name: "Focus",
      createdAt,
      updatedAt,
    };
    await collectionRegistry.upsert(collection);
    await workspaceRegistry.setPinnedAt("ws-organized", "2026-07-13T09:00:00.000Z");
    await workspaceRegistry.setCollectionId("ws-organized", collection.id);

    const reloadedWorkspaces = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    const reloadedCollections = new FileBackedWorkspaceCollectionRegistry(
      path.join(tmpDir, "projects", "workspace-collections.json"),
      logger,
    );
    const persisted = await reloadedWorkspaces.get("ws-organized");
    expect(persisted).toMatchObject({
      pinnedAt: "2026-07-13T09:00:00.000Z",
      collectionId: "wsc-focus",
      createdAt,
      updatedAt,
    });
    expect(await reloadedCollections.list()).toEqual([collection]);

    await reloadedCollections.remove(collection.id);
    expect(await reloadedCollections.list()).toEqual([]);
  });

  test("serializes concurrent workspace pin and collection mutations", async () => {
    const workspaceId = "ws-concurrent-organization";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-1",
        cwd: "/tmp/concurrent-organization",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.setPinnedAt(workspaceId, "2026-07-13T09:00:00.000Z"),
      workspaceRegistry.setCollectionId(workspaceId, "collection-focus"),
    ]);

    const persisted = await new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    ).get(workspaceId);
    expect(persisted).toMatchObject({
      pinnedAt: "2026-07-13T09:00:00.000Z",
      collectionId: "collection-focus",
    });
  });

  test("serializes concurrent workspace pin and archive mutations", async () => {
    const workspaceId = "ws-concurrent-archive";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-1",
        cwd: "/tmp/concurrent-archive",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.setPinnedAt(workspaceId, "2026-07-13T09:00:00.000Z"),
      workspaceRegistry.archive(workspaceId, "2026-07-13T09:30:00.000Z"),
    ]);

    const persisted = await new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    ).get(workspaceId);
    expect(persisted).toMatchObject({
      pinnedAt: "2026-07-13T09:00:00.000Z",
      archivedAt: "2026-07-13T09:30:00.000Z",
    });
  });

  test("does not let a stale workspace metadata upsert undo an archive", async () => {
    const workspaceId = "ws-stale-archive";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-1",
        cwd: "/tmp/stale-archive",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      }),
    );
    const staleMetadata = await workspaceRegistry.get(workspaceId);
    expect(staleMetadata).not.toBeNull();

    await workspaceRegistry.archive(workspaceId, "2026-07-13T09:00:00.000Z");
    await workspaceRegistry.upsert({
      ...staleMetadata!,
      displayName: "feature/refreshed",
      updatedAt: "2026-07-13T09:30:00.000Z",
    });

    expect(await workspaceRegistry.get(workspaceId)).toMatchObject({
      displayName: "feature/refreshed",
      archivedAt: "2026-07-13T09:00:00.000Z",
    });
  });

  test("does not let a stale workspace metadata upsert undo a title change", async () => {
    const workspaceId = "ws-stale-title";
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-1",
        cwd: "/tmp/stale-title",
        kind: "local_checkout",
        displayName: "main",
        title: "Old title",
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      }),
    );
    const staleMetadata = await workspaceRegistry.get(workspaceId);
    expect(staleMetadata).not.toBeNull();

    await workspaceRegistry.setTitle(workspaceId, "User title", "2026-07-13T09:00:00.000Z");
    await workspaceRegistry.setTitle(workspaceId, "Generated title", "2026-07-13T09:15:00.000Z", {
      expectedCurrentTitles: [null, "Prompt title"],
    });
    await workspaceRegistry.upsert({
      ...staleMetadata!,
      branch: "feature/refreshed",
      updatedAt: "2026-07-13T09:30:00.000Z",
    });

    expect(await workspaceRegistry.get(workspaceId)).toMatchObject({
      title: "User title",
      branch: "feature/refreshed",
    });
  });

  test("does not let a stale project metadata upsert undo an archive", async () => {
    const projectId = "project-stale-archive";
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId,
        rootPath: "/tmp/project-stale-archive",
        kind: "git",
        displayName: "project-stale-archive",
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      }),
    );
    const staleMetadata = await projectRegistry.get(projectId);
    expect(staleMetadata).not.toBeNull();

    await projectRegistry.archive(projectId, "2026-07-13T09:00:00.000Z");
    await projectRegistry.upsert({
      ...staleMetadata!,
      displayName: "project-refreshed",
      updatedAt: "2026-07-13T09:30:00.000Z",
    });

    expect(await projectRegistry.get(projectId)).toMatchObject({
      displayName: "project-refreshed",
      archivedAt: "2026-07-13T09:00:00.000Z",
    });
  });

  test("does not let a stale project metadata upsert undo a custom name change", async () => {
    const projectId = "project-stale-name";
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId,
        rootPath: "/tmp/project-stale-name",
        kind: "git",
        displayName: "project-stale-name",
        customName: "Old name",
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      }),
    );
    const staleMetadata = await projectRegistry.get(projectId);
    expect(staleMetadata).not.toBeNull();

    await projectRegistry.setCustomName(projectId, "User name", "2026-07-13T09:00:00.000Z");
    await projectRegistry.upsert({
      ...staleMetadata!,
      displayName: "project-refreshed",
      updatedAt: "2026-07-13T09:30:00.000Z",
    });

    expect(await projectRegistry.get(projectId)).toMatchObject({
      customName: "User name",
      displayName: "project-refreshed",
    });
  });

  test("loads once when the first record mutations start concurrently", async () => {
    const createWorkspace = (workspaceId: string) =>
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-1",
        cwd: `/tmp/${workspaceId}`,
        kind: "local_checkout",
        displayName: workspaceId,
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:30:00.000Z",
      });
    const uninitialized = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "concurrent-load.json"),
      logger,
    );

    await Promise.all([
      uninitialized.upsert(createWorkspace("ws-first-load-a")),
      uninitialized.upsert(createWorkspace("ws-first-load-b")),
    ]);

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "concurrent-load.json"),
      logger,
    );
    expect((await reloaded.list()).map((record) => record.workspaceId).sort()).toEqual([
      "ws-first-load-a",
      "ws-first-load-b",
    ]);
  });

  test("PIN: two checkouts of the same git remote collapse into a single project record", async () => {
    // Reproduces the situation in #987: two directories that share a git remote
    // both derive the same projectKey/displayName. Because the registry is keyed
    // by projectId, the second upsert overwrites the first — so the registry can
    // only ever hold one record per remote, and there is no way to distinguish
    // the two checkouts in the UI.
    await projectRegistry.initialize();

    const remoteKey = "remote:github.com/acme/repo";

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: remoteKey,
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: remoteKey,
        rootPath: "/home/me/scratch/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );

    const all = await projectRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.displayName).toBe("acme/repo");
    // Second upsert wins — the first rootPath is lost.
    expect(all[0]?.rootPath).toBe("/home/me/scratch/repo");
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});

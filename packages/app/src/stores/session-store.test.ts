import { afterEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

import {
  normalizeWorkspaceDescriptor,
  normalizeWorkspaceCollection,
  useSessionStore,
  type WorkspaceDescriptor,
} from "./session-store";
import { patchWorkspaceScripts } from "../contexts/session-workspace-scripts";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

afterEach(() => {
  useSessionStore.getState().clearSession("test-server");
});

function initializeTestSession(): void {
  useSessionStore.getState().initializeSession("test-server", null as unknown as DaemonClient);
}

function getTestSessionReferences() {
  const state = useSessionStore.getState();
  const session = state.sessions["test-server"];
  if (!session) {
    throw new Error("test session is not initialized");
  }
  return {
    sessions: state.sessions,
    session,
    workspaces: session.workspaces,
    workspaceCollections: session.workspaceCollections,
    emptyProjects: session.emptyProjects,
  };
}

describe("normalizeWorkspaceDescriptor", () => {
  it("normalizes workspace organization timestamps and scripts", () => {
    const scripts = [
      {
        scriptName: "web",
        type: "service" as const,
        hostname: "web.paseo.localhost",
        port: 3000,
        proxyUrl: "http://web.paseo.localhost:6767",
        lifecycle: "running" as const,
        health: "healthy" as const,
        exitCode: null,
        terminalId: null,
      },
    ];
    const workspace = normalizeWorkspaceDescriptor({
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      archivingAt: null,
      status: "running",
      statusEnteredAt: null,
      createdAt: "2026-04-19T23:59:00.000Z",
      activityAt: "2026-04-20T00:01:00.000Z",
      pinnedAt: "2026-04-20T00:02:00.000Z",
      collectionId: "collection-1",
      diffStat: null,
      scripts,
    });

    expect(workspace.scripts).toEqual([
      {
        scriptName: "web",
        type: "service",
        hostname: "web.paseo.localhost",
        port: 3000,
        proxyUrl: "http://web.paseo.localhost:6767",
        lifecycle: "running",
        health: "healthy",
        exitCode: null,
        terminalId: null,
      },
    ]);
    expect(workspace.scripts).not.toBe(scripts);
    expect(workspace.createdAt).toEqual(new Date("2026-04-19T23:59:00.000Z"));
    expect(workspace.activityAt).toEqual(new Date("2026-04-20T00:01:00.000Z"));
    expect(workspace.pinnedAt).toEqual(new Date("2026-04-20T00:02:00.000Z"));
    expect(workspace.collectionId).toBe("collection-1");
  });

  it("maps missing or invalid workspace organization fields to null", () => {
    const workspace = normalizeWorkspaceDescriptor({
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      archivingAt: null,
      status: "running",
      statusEnteredAt: null,
      createdAt: "not-a-date",
      activityAt: "not-a-date",
      pinnedAt: null,
      diffStat: null,
      scripts: [],
    });

    expect(workspace.createdAt).toBeNull();
    expect(workspace.activityAt).toBeNull();
    expect(workspace.pinnedAt).toBeNull();
    expect(workspace.collectionId).toBeNull();
  });

  it("canonicalizes the workspace directory and treats a blank one as empty", () => {
    const canonical = normalizeWorkspaceDescriptor({
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/app/",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
    });
    expect(canonical.workspaceDirectory).toBe("/repo/app");

    const blank = normalizeWorkspaceDescriptor({
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "   ",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
    });
    expect(blank.workspaceDirectory).toBe("");
  });

  it("defaults missing scripts to an empty array", () => {
    const payload = {
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
    } as WorkspaceDescriptorPayload;

    const workspace = normalizeWorkspaceDescriptor(payload);

    expect(workspace.scripts).toEqual([]);
  });

  it("defaults missing archivingAt to null", () => {
    const payload = {
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
      scripts: [],
    } as unknown as WorkspaceDescriptorPayload;

    const workspace = normalizeWorkspaceDescriptor(payload);

    expect(workspace.archivingAt).toBeNull();
  });

  it("normalizes statusEnteredAt strings to Date and missing or null values to null", () => {
    const basePayload = {
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      status: "running",
      activityAt: null,
      diffStat: null,
      scripts: [],
    } satisfies Omit<WorkspaceDescriptorPayload, "statusEnteredAt" | "archivingAt">;

    const withString = normalizeWorkspaceDescriptor({
      ...basePayload,
      archivingAt: null,
      statusEnteredAt: "2026-05-12T09:30:00.000Z",
    });
    const withNull = normalizeWorkspaceDescriptor({
      ...basePayload,
      archivingAt: null,
      statusEnteredAt: null,
    });
    const missing = normalizeWorkspaceDescriptor({
      ...basePayload,
      archivingAt: null,
    } as unknown as WorkspaceDescriptorPayload);

    expect(withString.statusEnteredAt).toEqual(new Date("2026-05-12T09:30:00.000Z"));
    expect(withNull.statusEnteredAt).toBeNull();
    expect(missing.statusEnteredAt).toBeNull();
  });

  it("preserves project placement from workspace descriptor payloads", () => {
    const workspace = normalizeWorkspaceDescriptor({
      id: "1",
      projectId: "remote:github.com/acme/app",
      projectDisplayName: "acme/app",
      projectRootPath: "/repo/app",
      workspaceDirectory: "/repo/app",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
      project: {
        projectKey: "remote:github.com/acme/app",
        projectName: "acme/app",
        checkout: {
          cwd: "/repo/app",
          isGit: true,
          currentBranch: "main",
          remoteUrl: "https://github.com/acme/app.git",
          worktreeRoot: "/repo/app",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      },
    });

    expect(workspace.project).toEqual({
      projectKey: "remote:github.com/acme/app",
      projectName: "acme/app",
      checkout: {
        cwd: "/repo/app",
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/app.git",
        worktreeRoot: "/repo/app",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
  });
});

describe("workspace collections", () => {
  it("normalizes daemon collection timestamps", () => {
    const collection = normalizeWorkspaceCollection({
      id: "collection-1",
      name: "Important",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:01:00.000Z",
    });

    expect(collection).toEqual({
      id: "collection-1",
      name: "Important",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:01:00.000Z"),
    });
  });

  it("stores a host-scoped collection catalog and preserves equal state", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const collection = normalizeWorkspaceCollection({
      id: "collection-1",
      name: "Important",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:01:00.000Z",
    });

    store.setWorkspaceCollections("test-server", [collection]);
    const before = getTestSessionReferences();
    store.setWorkspaceCollections("test-server", [{ ...collection }]);
    const after = getTestSessionReferences();

    expect(after.workspaceCollections.get(collection.id)).toEqual(collection);
    expect(after.sessions).toBe(before.sessions);
    expect(after.session).toBe(before.session);
  });
});

describe("commitWorkspaceSnapshot", () => {
  it("replays live workspace and catalog changes received during pagination", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const original = createWorkspace({ id: "workspace-1", collectionId: null });
    const removed = createWorkspace({ id: "workspace-removed" });
    store.setWorkspaces(
      "test-server",
      new Map([
        [original.id, original],
        [removed.id, removed],
      ]),
    );
    const snapshotToken = store.beginWorkspaceSnapshot("test-server");

    const liveCollection = normalizeWorkspaceCollection({
      id: "collection-live",
      name: "Live",
      createdAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:01:00.000Z",
    });
    store.mergeWorkspaces("test-server", [
      {
        ...original,
        pinnedAt: new Date("2026-07-13T10:02:00.000Z"),
        collectionId: liveCollection.id,
      },
    ]);
    store.removeWorkspace("test-server", removed.id);
    store.setWorkspaceCollections("test-server", [liveCollection]);

    const fetched = createWorkspace({ id: "workspace-fetched" });
    store.commitWorkspaceSnapshot(
      "test-server",
      {
        workspaces: new Map([
          [original.id, original],
          [removed.id, removed],
          [fetched.id, fetched],
        ]),
        workspaceCollections: [],
        emptyProjects: [],
      },
      snapshotToken,
    );

    const session = store.getSession("test-server");
    expect(session?.workspaces.get(original.id)).toMatchObject({
      pinnedAt: new Date("2026-07-13T10:02:00.000Z"),
      collectionId: liveCollection.id,
    });
    expect(session?.workspaces.has(removed.id)).toBe(false);
    expect(session?.workspaces.get(fetched.id)).toEqual(fetched);
    expect(Array.from(session?.workspaceCollections.values() ?? [])).toEqual([liveCollection]);
  });

  it("accepts authoritative empty projects after an unrelated live workspace update", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const original = createWorkspace({ id: "workspace-1", status: "done" });
    store.setWorkspaces("test-server", new Map([[original.id, original]]));
    const snapshotToken = store.beginWorkspaceSnapshot("test-server");

    store.mergeWorkspaces("test-server", [{ ...original, status: "running" }]);
    const emptyProject = {
      projectId: "empty-project",
      projectDisplayName: "Empty project",
      projectCustomName: null,
      projectRootPath: "/empty",
      projectKind: "non_git" as const,
    };
    store.commitWorkspaceSnapshot(
      "test-server",
      {
        workspaces: new Map([[original.id, original]]),
        workspaceCollections: [],
        emptyProjects: [emptyProject],
      },
      snapshotToken,
    );

    const session = store.getSession("test-server");
    expect(session?.workspaces.get(original.id)?.status).toBe("running");
    expect(session?.emptyProjects.get(emptyProject.projectId)).toEqual(emptyProject);
  });

  it("prevents an older overlapping snapshot from replacing a newer committed snapshot", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const original = createWorkspace({ id: "workspace-1", name: "Original" });
    store.setWorkspaces("test-server", new Map([[original.id, original]]));
    const olderToken = store.beginWorkspaceSnapshot("test-server");
    const newerToken = store.beginWorkspaceSnapshot("test-server");

    const newer = { ...original, name: "Newer snapshot" };
    store.commitWorkspaceSnapshot(
      "test-server",
      { workspaces: new Map([[newer.id, newer]]), workspaceCollections: [], emptyProjects: [] },
      newerToken,
    );
    store.commitWorkspaceSnapshot(
      "test-server",
      {
        workspaces: new Map([[original.id, original]]),
        workspaceCollections: [],
        emptyProjects: [],
      },
      olderToken,
    );

    expect(store.getSession("test-server")?.workspaces.get(original.id)?.name).toBe(
      "Newer snapshot",
    );
    expect(store.getSession("test-server")?.workspaceRevisionById.size).toBe(0);
    expect(store.getSession("test-server")?.workspaceRemovalRevisionById.size).toBe(0);
  });

  it("allows a newer overlapping snapshot to replace an older snapshot that completed first", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const original = createWorkspace({ id: "workspace-1", name: "Original" });
    store.setWorkspaces("test-server", new Map([[original.id, original]]));
    const olderToken = store.beginWorkspaceSnapshot("test-server");
    const newerToken = store.beginWorkspaceSnapshot("test-server");

    const older = { ...original, name: "Older snapshot" };
    const newer = { ...original, name: "Newer snapshot" };
    store.commitWorkspaceSnapshot(
      "test-server",
      { workspaces: new Map([[older.id, older]]), workspaceCollections: [], emptyProjects: [] },
      olderToken,
    );
    store.commitWorkspaceSnapshot(
      "test-server",
      { workspaces: new Map([[newer.id, newer]]), workspaceCollections: [], emptyProjects: [] },
      newerToken,
    );

    expect(store.getSession("test-server")?.workspaces.get(original.id)?.name).toBe(
      "Newer snapshot",
    );
  });

  it("rejects a snapshot started by a cleared session with the same server id", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const staleWorkspace = createWorkspace({ id: "workspace-stale" });
    const staleToken = store.beginWorkspaceSnapshot("test-server");
    const staleSessionId = staleToken.sessionId;

    store.clearSession("test-server");
    initializeTestSession();
    const replacement = store.getSession("test-server");
    expect(replacement?.workspaceSnapshotSessionId).not.toBe(staleSessionId);

    const didCommit = store.commitWorkspaceSnapshot(
      "test-server",
      {
        workspaces: new Map([[staleWorkspace.id, staleWorkspace]]),
        workspaceCollections: [],
        emptyProjects: [],
      },
      staleToken,
    );
    if (didCommit) store.setHasHydratedWorkspaces("test-server", true);

    const afterStaleCompletion = store.getSession("test-server");
    expect(didCommit).toBe(false);
    expect(afterStaleCompletion?.workspaces.size).toBe(0);
    expect(afterStaleCompletion?.hasHydratedWorkspaces).toBe(false);
  });

  it("keeps a concurrently removed project tombstoned when a delayed page contains another child", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const firstChild = createWorkspace({ id: "workspace-first", projectId: "project-removed" });
    store.setWorkspaces("test-server", new Map([[firstChild.id, firstChild]]));
    const snapshotToken = store.beginWorkspaceSnapshot("test-server");

    store.removeProjectWorkspaces("test-server", "project-removed");
    const delayedChild = createWorkspace({
      id: "workspace-delayed",
      projectId: "project-removed",
    });
    store.commitWorkspaceSnapshot(
      "test-server",
      {
        workspaces: new Map([
          [firstChild.id, firstChild],
          [delayedChild.id, delayedChild],
        ]),
        workspaceCollections: [],
        emptyProjects: [
          {
            projectId: "project-removed",
            projectDisplayName: "Removed",
            projectCustomName: null,
            projectRootPath: "/removed",
            projectKind: "non_git",
          },
        ],
      },
      snapshotToken,
    );

    const session = store.getSession("test-server");
    expect(session?.workspaces.size).toBe(0);
    expect(session?.emptyProjects.has("project-removed")).toBe(false);
  });
});

describe("mergeWorkspaces", () => {
  it("preserves scripts on merged workspace entries", () => {
    const store = useSessionStore.getState();
    store.initializeSession("test-server", null as unknown as DaemonClient);
    store.setWorkspaces(
      "test-server",
      new Map([["/repo/main", createWorkspace({ id: "/repo/main", scripts: [] })]]),
    );

    store.mergeWorkspaces("test-server", [
      createWorkspace({
        id: "/repo/main",
        scripts: [
          {
            scriptName: "web",
            type: "service",
            hostname: "web.paseo.localhost",
            port: 3000,
            proxyUrl: "http://web.paseo.localhost:6767",
            lifecycle: "running",
            health: "healthy",
            exitCode: null,
            terminalId: null,
          },
        ],
      }),
    ]);

    expect(store.getSession("test-server")?.workspaces.get("/repo/main")?.scripts).toEqual([
      {
        scriptName: "web",
        type: "service",
        hostname: "web.paseo.localhost",
        port: 3000,
        proxyUrl: "http://web.paseo.localhost:6767",
        lifecycle: "running",
        health: "healthy",
        exitCode: null,
        terminalId: null,
      },
    ]);
  });

  it("preserves identity when merging content-equal workspace descriptors", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspace = createWorkspace({ id: "/repo/main" });

    store.mergeWorkspaces("test-server", [workspace]);
    const first = getTestSessionReferences();

    store.mergeWorkspaces("test-server", [{ ...workspace, scripts: [...workspace.scripts] }]);
    const second = getTestSessionReferences();

    expect(second.sessions).toBe(first.sessions);
    expect(second.session).toBe(first.session);
    expect(second.workspaces).toBe(first.workspaces);
    expect(second.workspaces.get("/repo/main")).toBe(first.workspaces.get("/repo/main"));
  });

  it("preserves unaffected workspace entry identity when one workspace changes", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspaceA = createWorkspace({ id: "/repo/a", name: "main" });
    const workspaceB = createWorkspace({ id: "/repo/b", name: "feature" });

    store.mergeWorkspaces("test-server", [workspaceA, workspaceB]);
    const before = getTestSessionReferences();
    const beforeA = before.workspaces.get("/repo/a");
    const beforeB = before.workspaces.get("/repo/b");

    store.mergeWorkspaces("test-server", [{ ...workspaceA, status: "running" }]);
    const after = getTestSessionReferences();

    expect(after.sessions).not.toBe(before.sessions);
    expect(after.session).not.toBe(before.session);
    expect(after.workspaces).not.toBe(before.workspaces);
    expect(after.workspaces.get("/repo/a")).not.toBe(beforeA);
    expect(after.workspaces.get("/repo/b")).toBe(beforeB);
  });

  it("uses incoming null diff stat as authoritative", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspace = createWorkspace({
      id: "/repo/main",
      diffStat: { additions: 2, deletions: 1 },
    });
    store.mergeWorkspaces("test-server", [workspace]);
    const before = getTestSessionReferences();

    store.mergeWorkspaces("test-server", [{ ...workspace, diffStat: null }]);
    const after = getTestSessionReferences();

    expect(after.sessions).not.toBe(before.sessions);
    expect(after.session).not.toBe(before.session);
    expect(after.workspaces).not.toBe(before.workspaces);
    expect(after.workspaces.get(workspace.id)?.diffStat).toBeNull();
  });

  it("clears a pending restore status when the matching descriptor lands", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    store.setWorkspaceRestoreStatus("test-server", "/repo/main", "restoring");
    expect(getTestSessionReferences().session.restoringWorkspaces.get("/repo/main")).toBe(
      "restoring",
    );

    store.mergeWorkspaces("test-server", [createWorkspace({ id: "/repo/main" })]);

    expect(getTestSessionReferences().session.restoringWorkspaces.has("/repo/main")).toBe(false);
  });
});

describe("setWorkspaceRestoreStatus", () => {
  it("marks restoring then failed while the workspace is still absent", () => {
    const store = useSessionStore.getState();
    initializeTestSession();

    store.setWorkspaceRestoreStatus("test-server", "/repo/main", "restoring");
    store.setWorkspaceRestoreStatus("test-server", "/repo/main", "failed");

    expect(getTestSessionReferences().session.restoringWorkspaces.get("/repo/main")).toBe("failed");
  });

  it("ignores a late failed once the descriptor has landed (no-op)", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    store.setWorkspaceRestoreStatus("test-server", "/repo/main", "restoring");
    store.mergeWorkspaces("test-server", [createWorkspace({ id: "/repo/main" })]);

    store.setWorkspaceRestoreStatus("test-server", "/repo/main", "failed");

    expect(getTestSessionReferences().session.restoringWorkspaces.has("/repo/main")).toBe(false);
  });

  it("ignores failed when no restore is in flight", () => {
    const store = useSessionStore.getState();
    initializeTestSession();

    store.setWorkspaceRestoreStatus("test-server", "/repo/main", "failed");

    expect(getTestSessionReferences().session.restoringWorkspaces.has("/repo/main")).toBe(false);
  });
});

describe("setWorkspaces", () => {
  it("preserves identity when replacing workspaces with content-equal entries", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspace = createWorkspace({ id: "/repo/main" });
    store.setWorkspaces("test-server", new Map([[workspace.id, workspace]]));
    const before = getTestSessionReferences();

    store.setWorkspaces(
      "test-server",
      new Map([[workspace.id, { ...workspace, scripts: [...workspace.scripts] }]]),
    );
    const after = getTestSessionReferences();

    expect(after.sessions).toBe(before.sessions);
    expect(after.session).toBe(before.session);
    expect(after.workspaces).toBe(before.workspaces);
    expect(after.workspaces.get(workspace.id)).toBe(before.workspaces.get(workspace.id));
  });
});

describe("removeWorkspace", () => {
  it("preserves identity when removing a missing workspace", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspace = createWorkspace({ id: "/repo/main" });
    store.setWorkspaces("test-server", new Map([[workspace.id, workspace]]));
    const before = getTestSessionReferences();

    store.removeWorkspace("test-server", "/repo/missing");
    const after = getTestSessionReferences();

    expect(after.sessions).toBe(before.sessions);
    expect(after.session).toBe(before.session);
    expect(after.workspaces).toBe(before.workspaces);
  });
});

describe("removeEmptyProject", () => {
  it("removes an empty project by project id", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    store.setEmptyProjects("test-server", [
      {
        projectId: "project-empty",
        projectDisplayName: "Empty",
        projectCustomName: null,
        projectRootPath: "/repo/empty",
        projectKind: "git",
      },
    ]);

    store.removeEmptyProject("test-server", "project-empty");

    expect(getTestSessionReferences().emptyProjects.has("project-empty")).toBe(false);
  });

  it("preserves identity when removing a missing empty project", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    store.setEmptyProjects("test-server", [
      {
        projectId: "project-empty",
        projectDisplayName: "Empty",
        projectCustomName: null,
        projectRootPath: "/repo/empty",
        projectKind: "git",
      },
    ]);
    const before = getTestSessionReferences();

    store.removeEmptyProject("test-server", "project-missing");
    const after = getTestSessionReferences();

    expect(after.sessions).toBe(before.sessions);
    expect(after.session).toBe(before.session);
    expect(after.emptyProjects).toBe(before.emptyProjects);
  });
});

describe("patchWorkspaceScripts", () => {
  it("preserves workspace entry identity when scripts are content-equal", () => {
    const script = {
      scriptName: "web",
      type: "service" as const,
      hostname: "web.paseo.localhost",
      port: 3000,
      proxyUrl: "http://web.paseo.localhost:6767",
      lifecycle: "running" as const,
      health: "healthy" as const,
      exitCode: null,
      terminalId: null,
    };
    const workspace = createWorkspace({ id: "/repo/main", scripts: [script] });
    const current = new Map([[workspace.id, workspace]]);

    const next = patchWorkspaceScripts(current, {
      workspaceId: workspace.id,
      scripts: [{ ...script }],
    });

    expect(next).toBe(current);
    expect(next.get(workspace.id)).toBe(workspace);
  });
});

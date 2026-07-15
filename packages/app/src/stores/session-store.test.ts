import { afterEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type EmptyProjectDescriptor,
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
    projectCustomName: input.projectCustomName ?? null,
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

function createProject(
  input: Partial<EmptyProjectDescriptor> & Pick<EmptyProjectDescriptor, "projectId">,
): EmptyProjectDescriptor {
  return {
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectCustomName: input.projectCustomName ?? null,
    projectRootPath: input.projectRootPath ?? "/repo",
    projectKind: input.projectKind ?? "git",
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
    emptyProjects: session.emptyProjects,
  };
}

describe("normalizeWorkspaceDescriptor", () => {
  it("normalizes workspace scripts and invalid activity timestamps", () => {
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
      activityAt: "not-a-date",
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

describe("applyProjectUpdate", () => {
  it("inserts an unseen project into the empty-project projection", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const project = createProject({
      projectId: "project-empty",
      projectDisplayName: "Empty project",
      projectRootPath: "/empty",
      projectKind: "non_git",
    });

    store.applyProjectUpdate("test-server", {
      kind: "upsert",
      project,
    });

    expect(getTestSessionReferences().emptyProjects).toEqual(
      new Map([[project.projectId, project]]),
    );
  });

  it("updates the metadata of an existing empty project", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const existing = createProject({ projectId: "project-empty" });
    const updated = createProject({
      projectId: existing.projectId,
      projectDisplayName: "Renamed project",
      projectCustomName: "Personal name",
      projectRootPath: "/moved/repo",
      projectKind: "non_git",
    });
    store.setEmptyProjects("test-server", [existing]);

    store.applyProjectUpdate("test-server", { kind: "upsert", project: updated });

    expect(getTestSessionReferences().emptyProjects).toEqual(
      new Map([[updated.projectId, updated]]),
    );
  });

  it("patches project metadata onto every workspace attached to the project", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const main = createWorkspace({ id: "workspace-main", projectId: "project-1" });
    const feature = createWorkspace({ id: "workspace-feature", projectId: "project-1" });
    const unrelated = createWorkspace({ id: "workspace-other", projectId: "project-2" });
    store.setWorkspaces(
      "test-server",
      new Map([
        [main.id, main],
        [feature.id, feature],
        [unrelated.id, unrelated],
      ]),
    );
    const project = createProject({
      projectId: "project-1",
      projectDisplayName: "Renamed project",
      projectCustomName: "Personal name",
      projectRootPath: "/moved/repo",
      projectKind: "non_git",
    });

    store.applyProjectUpdate("test-server", { kind: "upsert", project });

    const workspaces = getTestSessionReferences().workspaces;
    const projectMetadata = {
      projectDisplayName: project.projectDisplayName,
      projectCustomName: project.projectCustomName,
      projectRootPath: project.projectRootPath,
      projectKind: project.projectKind,
    };
    expect(workspaces).toEqual(
      new Map([
        [main.id, { ...main, ...projectMetadata }],
        [feature.id, { ...feature, ...projectMetadata }],
        [unrelated.id, unrelated],
      ]),
    );
    expect(workspaces.get(unrelated.id)).toBe(unrelated);
  });

  it("removes a stale empty-project projection when the project has a workspace", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspace = createWorkspace({ id: "workspace-main", projectId: "project-1" });
    const project = createProject({
      projectId: workspace.projectId,
      projectDisplayName: workspace.projectDisplayName,
      projectCustomName: workspace.projectCustomName,
      projectRootPath: workspace.projectRootPath,
      projectKind: workspace.projectKind,
    });
    store.setWorkspaces("test-server", new Map([[workspace.id, workspace]]));
    store.setEmptyProjects("test-server", [project]);

    store.applyProjectUpdate("test-server", { kind: "upsert", project });

    const after = getTestSessionReferences();
    expect(after.emptyProjects).toEqual(new Map());
    expect(after.workspaces.get(workspace.id)).toBe(workspace);
  });

  it("removes every workspace and empty-project projection for a removed project", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const removedMain = createWorkspace({ id: "workspace-main", projectId: "project-1" });
    const removedFeature = createWorkspace({ id: "workspace-feature", projectId: "project-1" });
    const remainingWorkspace = createWorkspace({ id: "workspace-other", projectId: "project-2" });
    const removedProject = createProject({ projectId: "project-1" });
    const remainingProject = createProject({ projectId: "project-empty" });
    store.setWorkspaces(
      "test-server",
      new Map([
        [removedMain.id, removedMain],
        [removedFeature.id, removedFeature],
        [remainingWorkspace.id, remainingWorkspace],
      ]),
    );
    store.setEmptyProjects("test-server", [removedProject, remainingProject]);

    store.applyProjectUpdate("test-server", {
      kind: "remove",
      projectId: removedProject.projectId,
    });

    const after = getTestSessionReferences();
    expect(after.workspaces).toEqual(new Map([[remainingWorkspace.id, remainingWorkspace]]));
    expect(after.emptyProjects).toEqual(new Map([[remainingProject.projectId, remainingProject]]));
    expect(after.workspaces.get(remainingWorkspace.id)).toBe(remainingWorkspace);
  });

  it("preserves session and workspace identity when an upsert changes nothing", () => {
    const store = useSessionStore.getState();
    initializeTestSession();
    const workspace = createWorkspace({ id: "workspace-main", projectId: "project-1" });
    const project = createProject({
      projectId: workspace.projectId,
      projectDisplayName: workspace.projectDisplayName,
      projectCustomName: workspace.projectCustomName,
      projectRootPath: workspace.projectRootPath,
      projectKind: workspace.projectKind,
    });
    store.setWorkspaces("test-server", new Map([[workspace.id, workspace]]));
    const before = getTestSessionReferences();

    store.applyProjectUpdate("test-server", { kind: "upsert", project });

    const after = getTestSessionReferences();
    expect(after.sessions).toBe(before.sessions);
    expect(after.session).toBe(before.session);
    expect(after.workspaces).toBe(before.workspaces);
    expect(after.workspaces.get(workspace.id)).toBe(workspace);
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

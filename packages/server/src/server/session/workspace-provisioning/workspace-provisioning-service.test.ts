import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "../../test-utils/workspace-git-service-stub.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type PersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import {
  createWorkspaceProvisioningService,
  WorkspaceProvisioningError,
  type WorkspaceProvisioningService,
} from "./workspace-provisioning-service.js";

// Real file-backed registries + a fake git-service port (the only dependency that
// shells out to git in production). No module mocks — the service is exercised
// through the same interface its callers in session.ts use.

const logger = createTestLogger();
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z";
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

let tmpDir: string;
let gitRoots: Set<string>;
let gitBranches: Map<string, string | null>;
let checkoutFailure: Error | null;
let workspaceRegistry: FileBackedWorkspaceRegistry;
let projectRegistry: FileBackedProjectRegistry;
let provisioning: WorkspaceProvisioningService;

function gitService() {
  return createNoopWorkspaceGitService({
    peekSnapshot: () => null,
    getCheckout: async (cwd: string) => {
      if (checkoutFailure) throw checkoutFailure;
      let worktreeRoot: string | null = null;
      for (const root of gitRoots) {
        if (
          (cwd === root || cwd.startsWith(`${root}${path.sep}`)) &&
          root.length > (worktreeRoot?.length ?? -1)
        ) {
          worktreeRoot = root;
        }
      }
      return {
        cwd,
        isGit: worktreeRoot !== null,
        currentBranch: worktreeRoot ? (gitBranches.get(worktreeRoot) ?? "main") : null,
        remoteUrl: null,
        worktreeRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      };
    },
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-provisioning-"));
  gitRoots = new Set();
  gitBranches = new Map();
  checkoutFailure = null;
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "projects", "workspaces.json"),
    logger,
  );
  projectRegistry = new FileBackedProjectRegistry(
    path.join(tmpDir, "projects", "projects.json"),
    logger,
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    logger,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("fresh git repo creates a workspace at the canonical worktree root", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const workspace = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(workspace.cwd).toBe(repo);
  expect(await workspaceRegistry.list()).toHaveLength(1);
  expect(await projectRegistry.list()).toHaveLength(1);
});

test("fresh non-git directory creates a directory workspace at the exact path", async () => {
  const dir = path.join(tmpDir, "plain");

  const workspace = await provisioning.findOrCreateWorkspaceForDirectory(dir);

  expect(workspace.cwd).toBe(dir);
});

test("re-opening an active workspace by exact path returns the same record without duplicating", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  const second = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(second.workspaceId).toBe(first.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("re-opening Windows-equivalent workspace cwd spellings reuses the active and archived record", async () => {
  const cwd = path.join(tmpDir, "workspace");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  await workspaceRegistry.upsert({ ...created, cwd: `${cwd}${path.sep}` });

  const active = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(active.workspaceId).toBe(created.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(1);

  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(reopened).toMatchObject({ workspaceId: created.workspaceId, archivedAt: null });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("re-opening refreshes mutable checkout metadata without renaming the workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  const first = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.upsert({ ...first, title: "Pinned work" });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/refresh");

  const refreshed = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(refreshed).toMatchObject({
    workspaceId: first.workspaceId,
    kind: "local_checkout",
    branch: "feature/refresh",
    displayName: first.displayName,
    title: "Pinned work",
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  });
  expect(await workspaceRegistry.get(first.workspaceId)).toEqual(refreshed);
  expect((await projectRegistry.get(first.projectId))?.kind).toBe("git");
});

test("persists manual worktree ownership separately from its workspace kind", async () => {
  const cwd = path.join(tmpDir, "manual-worktree");
  const mainRepoRoot = path.join(tmpDir, "main-repo");
  const manualWorktreeProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: createNoopWorkspaceGitService({
      peekSnapshot: () => null,
      getCheckout: async () => ({
        cwd,
        isGit: true,
        currentBranch: "feature/manual",
        remoteUrl: null,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot,
      }),
    }),
  });

  const workspace = await manualWorktreeProvisioning.findOrCreateWorkspaceForDirectory(cwd);

  expect(workspace).toMatchObject({
    kind: "worktree",
    isPaseoOwnedWorktree: false,
    mainRepoRoot,
  });
});

test("re-opening an archived workspace by its exact path unarchives it and keeps the id", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened.workspaceId).toBe(created.workspaceId);
  expect(reopened.archivedAt).toBeNull();
});

test("reopening archived exact-root records restores the fresh Git project", async () => {
  const cwd = path.join(tmpDir, "repo");
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: cwd,
    kind: "non_git",
    displayName: "repo",
    timestamp: ARCHIVED_AT,
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived-root",
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "repo",
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
  });
  await workspaceRegistry.upsert(workspace);
  await projectRegistry.archive(project.projectId, ARCHIVED_AT);
  const archivedProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: createNoopWorkspaceGitService({
      peekSnapshot: () => null,
      getCheckout: async () => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    }),
  });

  const reopened = await archivedProvisioning.ensureWorkspaceRecordUnarchived(workspace);

  expect(reopened).toMatchObject({
    workspaceId: workspace.workspaceId,
    kind: "local_checkout",
    archivedAt: null,
  });
  expect(await projectRegistry.get(project.projectId)).toMatchObject({
    kind: "git",
    archivedAt: null,
  });
});

test("uses one workspace snapshot when reopening an archived workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const archived = (await workspaceRegistry.list()).filter(
    (workspace) => workspace.workspaceId === created.workspaceId,
  );
  let reads = 0;
  const snapshotRegistry: WorkspaceRegistry = {
    initialize: () => workspaceRegistry.initialize(),
    existsOnDisk: () => workspaceRegistry.existsOnDisk(),
    list: async () => (reads++ === 0 ? archived : []),
    get: (workspaceId) => workspaceRegistry.get(workspaceId),
    upsert: (workspace) => workspaceRegistry.upsert(workspace),
    archive: (workspaceId, archivedAt) => workspaceRegistry.archive(workspaceId, archivedAt),
    remove: (workspaceId) => workspaceRegistry.remove(workspaceId),
  };
  const snapshotProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry: snapshotRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
  });

  const reopened = await snapshotProvisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({ workspaceId: created.workspaceId, archivedAt: null });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("reopening an archived workspace refreshes placement without renaming it", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.upsert({ ...created, title: "Pinned archived work" });
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  gitRoots.delete(repo);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    projectId: created.projectId,
    title: "Pinned archived work",
    kind: "directory",
    branch: null,
    displayName: created.displayName,
    archivedAt: null,
  });
  expect(reopened.updatedAt).toEqual(expect.any(String));
  expect(await workspaceRegistry.get(created.workspaceId)).toEqual(reopened);
});

test("opening a subpath of an archived git workspace mints a fresh workspace at the exact subpath", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const canonical = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(canonical.workspaceId, ARCHIVED_AT);
  const sub = path.join(repo, "packages", "app");

  const fresh = await provisioning.findOrCreateWorkspaceForDirectory(sub);

  expect(fresh.cwd).toBe(sub);
  expect(fresh.workspaceId).not.toBe(canonical.workspaceId);
  expect((await workspaceRegistry.get(canonical.workspaceId))?.archivedAt).toBe(ARCHIVED_AT);
});

test("ensureWorkspaceRecordUnarchived restores the owning archived project with the workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await projectRegistry.archive(created.projectId, ARCHIVED_AT);

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived({
    ...created,
    archivedAt: ARCHIVED_AT,
  });

  expect(unarchived.archivedAt).toBeNull();
  expect((await workspaceRegistry.get(created.workspaceId))?.archivedAt).toBeNull();
  expect((await projectRegistry.get(created.projectId))?.archivedAt).toBeNull();
});

test("does not unarchive either record when checkout refresh fails", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await projectRegistry.archive(created.projectId, ARCHIVED_AT);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const archivedProject = await projectRegistry.get(created.projectId);
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  checkoutFailure = new Error("Git read failed");

  await expect(provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!)).rejects.toThrow(
    "Git read failed",
  );

  expect(await projectRegistry.get(created.projectId)).toEqual(archivedProject);
  expect(await workspaceRegistry.get(created.workspaceId)).toEqual(archivedWorkspace);
});

test("resolveOrCreateWorkspaceIdForCreateAgent returns a created worktree's id without touching the registry", async () => {
  // The branch only reads workspace.workspaceId off the worktree result.
  const createdWorktree = {
    workspace: { workspaceId: "ws-from-worktree" },
  } as unknown as CreatePaseoWorktreeWorkflowResult;

  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree,
    cwd: path.join(tmpDir, "x"),
    initialTitle: null,
  });

  expect(id).toBe("ws-from-worktree");
  expect(await workspaceRegistry.list()).toHaveLength(0);
});

test("resolveOrCreateWorkspaceIdForCreateAgent honors an explicitly requested workspace id", async () => {
  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree: null,
    requestedWorkspaceId: "ws-requested",
    cwd: path.join(tmpDir, "x"),
    initialTitle: null,
  });

  expect(id).toBe("ws-requested");
  expect(await workspaceRegistry.list()).toHaveLength(0);
});

test("resolveOrCreateWorkspaceIdForCreateAgent creates a titled workspace when nothing is provided", async () => {
  const dir = path.join(tmpDir, "plain");

  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree: null,
    cwd: dir,
    initialTitle: "My Title",
  });

  const created = await workspaceRegistry.get(id);
  expect(created?.cwd).toBe(dir);
  expect(created?.title).toBe("My Title");
});

test("createWorkspaceForDirectory always mints a fresh workspace even when one already occupies the cwd", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.createWorkspaceForDirectory(repo);
  const second = await provisioning.createWorkspaceForDirectory(repo);

  expect(second.workspaceId).not.toBe(first.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(2);
});

test("directory creation persists the live branch and a trimmed title", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const workspace = await provisioning.createWorkspaceForDirectory(repo, "  Focused work  ");
  expect(workspace).toMatchObject({ branch: "main", title: "Focused work" });
});

test("createWorkspaceForDirectory honors an explicit active project without cwd containment", async () => {
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: path.join(tmpDir, "elsewhere"),
    kind: "non_git",
    displayName: "elsewhere",
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  const workspace = await provisioning.createWorkspaceForDirectory(
    path.join(tmpDir, "directory"),
    null,
    project.projectId,
  );
  expect(workspace.projectId).toBe(project.projectId);
});

test("createWorkspaceForDirectory refreshes an explicit project's stale Git kind", async () => {
  const rootPath = path.join(tmpDir, "repo");
  gitRoots.add(rootPath);
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath,
    kind: "non_git",
    displayName: "Saved project name",
    timestamp: ARCHIVED_AT,
  });
  await projectRegistry.upsert({ ...project, customName: "Pinned project name" });

  const workspace = await provisioning.createWorkspaceForDirectory(
    rootPath,
    null,
    project.projectId,
  );

  expect(workspace.projectId).toBe(project.projectId);
  expect(await projectRegistry.get(project.projectId)).toMatchObject({
    projectId: project.projectId,
    rootPath,
    kind: "git",
    displayName: "Saved project name",
    customName: "Pinned project name",
  });
});

test("createWorkspaceForDirectory classifies unknown and archived explicit projects", async () => {
  await expect(
    provisioning.createWorkspaceForDirectory(path.join(tmpDir, "directory"), null, "missing"),
  ).rejects.toMatchObject({
    code: "unknown_project",
  } satisfies Partial<WorkspaceProvisioningError>);
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: path.join(tmpDir, "archived"),
    kind: "non_git",
    displayName: "archived",
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  await projectRegistry.archive(project.projectId, "2026-03-02T00:00:00.000Z");
  await expect(
    provisioning.createWorkspaceForDirectory(
      path.join(tmpDir, "directory"),
      null,
      project.projectId,
    ),
  ).rejects.toMatchObject({
    code: "archived_project",
  } satisfies Partial<WorkspaceProvisioningError>);
});

test("findOrCreateProjectForDirectory keeps nested selected roots independent", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateProjectForDirectory(repo);
  const second = await provisioning.findOrCreateProjectForDirectory(path.join(repo, "sub"));

  expect(second.projectId).not.toBe(first.projectId);
  expect(first.rootPath).toBe(repo);
  expect(second.rootPath).toBe(path.join(repo, "sub"));
  expect(await projectRegistry.list()).toHaveLength(2);
});

test("runInImportWorkspace uses an active requested workspace without creating another", async () => {
  const cwd = path.join(tmpDir, "requested");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd, requestedWorkspaceId: workspace.workspaceId },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.list()).toEqual([workspace]);
});

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace rejects a %s requested workspace before importing",
  async (state) => {
    const cwd = path.join(tmpDir, "unavailable-workspace");
    mkdirSync(cwd);
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    if (state === "archived") {
      await workspaceRegistry.archive(workspace.workspaceId, ARCHIVED_AT);
    } else {
      await workspaceRegistry.remove(workspace.workspaceId);
    }
    let imported = false;

    await expect(
      provisioning.runInImportWorkspace(
        { cwd, requestedWorkspaceId: workspace.workspaceId },
        async () => {
          imported = true;
        },
      ),
    ).rejects.toThrow(`Workspace not found: ${workspace.workspaceId}`);
    expect(imported).toBe(false);
  },
);

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace rejects a requested workspace whose project is %s before importing",
  async (state) => {
    const cwd = path.join(tmpDir, "unavailable-project");
    mkdirSync(cwd);
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    if (state === "archived") {
      await projectRegistry.archive(workspace.projectId, ARCHIVED_AT);
    } else {
      await projectRegistry.remove(workspace.projectId);
    }
    let imported = false;

    await expect(
      provisioning.runInImportWorkspace(
        { cwd, requestedWorkspaceId: workspace.workspaceId },
        async () => {
          imported = true;
        },
      ),
    ).rejects.toThrow(`Project not found: ${workspace.projectId}`);
    expect(imported).toBe(false);
  },
);

test("runInImportWorkspace accepts a filesystem-equivalent requested cwd", async () => {
  const cwd = path.join(tmpDir, "real-directory");
  const alias = path.join(tmpDir, "directory-alias");
  mkdirSync(cwd);
  symlinkSync(cwd, alias, directorySymlinkType);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd: alias, requestedWorkspaceId: workspace.workspaceId },
    async (target) => target.workspaceId,
  );

  expect(result.value).toBe(workspace.workspaceId);
});

test("runInImportWorkspace rejects a requested workspace with a different cwd", async () => {
  const cwd = path.join(tmpDir, "workspace-directory");
  const otherCwd = path.join(tmpDir, "other-directory");
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  let imported = false;

  await expect(
    provisioning.runInImportWorkspace(
      { cwd: otherCwd, requestedWorkspaceId: workspace.workspaceId },
      async () => {
        imported = true;
      },
    ),
  ).rejects.toThrow(`Import cwd does not match workspace: ${workspace.workspaceId}`);
  expect(imported).toBe(false);
});

test("runInImportWorkspace creates one fresh workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "fresh-import");
  mkdirSync(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (workspace) => workspace.workspaceId,
  );

  expect(result.value).toBe(result.createdWorkspace?.workspaceId);
  expect(await workspaceRegistry.list()).toEqual([result.createdWorkspace]);
});

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace restores the exact %s project state when an untargeted import fails",
  async (state) => {
    const cwd = path.join(tmpDir, `failed-import-${state}`);
    mkdirSync(cwd);
    let previousProject: PersistedProjectRecord | null = null;
    if (state === "archived") {
      const project = await provisioning.findOrCreateProjectForDirectory(cwd);
      await projectRegistry.archive(project.projectId, ARCHIVED_AT);
      previousProject = await projectRegistry.get(project.projectId);
    }

    await expect(
      provisioning.runInImportWorkspace({ cwd }, async () => {
        throw new Error("provider session is unavailable");
      }),
    ).rejects.toThrow("provider session is unavailable");

    expect(await workspaceRegistry.list()).toEqual([]);
    expect(await projectRegistry.list()).toEqual(previousProject ? [previousProject] : []);
  },
);

import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "../../test-utils/workspace-git-service-stub.js";
import {
  createPersistedProjectRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import {
  createWorkspaceProvisioningService,
  type WorkspaceProvisioningService,
} from "./workspace-provisioning-service.js";

// Real file-backed registries + a fake git-service port (the only dependency that
// shells out to git in production). No module mocks — the service is exercised
// through the same interface its callers in session.ts use.

const logger = createTestLogger();
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z";

let tmpDir: string;
let gitRoots: Set<string>;
// Per-root git facts the stub reports; empty by default (existing tests stay no-remote).
let remoteByRoot: Map<string, string>;
let mainRepoRootByPath: Map<string, string>;
let workspaceRegistry: FileBackedWorkspaceRegistry;
let projectRegistry: FileBackedProjectRegistry;
let provisioning: WorkspaceProvisioningService;

function gitService() {
  return createNoopWorkspaceGitService({
    peekSnapshot: () => null,
    getCheckout: async (cwd: string) => {
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
        currentBranch: worktreeRoot ? "main" : null,
        remoteUrl: worktreeRoot ? (remoteByRoot.get(worktreeRoot) ?? null) : null,
        worktreeRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: worktreeRoot ? (mainRepoRootByPath.get(worktreeRoot) ?? null) : null,
      };
    },
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-provisioning-"));
  gitRoots = new Set();
  remoteByRoot = new Map();
  mainRepoRootByPath = new Map();
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

test("re-opening an archived workspace by its exact path unarchives it and keeps the id", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened.workspaceId).toBe(created.workspaceId);
  expect(reopened.archivedAt).toBeNull();
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

test("ensureWorkspaceRecordUnarchived clears archivedAt on the workspace and its project", async () => {
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

test("findOrCreateProjectForDirectory reuses the active project for the same root", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateProjectForDirectory(repo);
  const second = await provisioning.findOrCreateProjectForDirectory(path.join(repo, "sub"));

  expect(second.projectId).toBe(first.projectId);
  expect(await projectRegistry.list()).toHaveLength(1);
});

test("two independent clones of the same remote become two distinct projects (#987)", async () => {
  const work = path.join(tmpDir, "work", "repo");
  const scratch = path.join(tmpDir, "scratch", "repo");
  gitRoots.add(work);
  gitRoots.add(scratch);
  remoteByRoot.set(work, "https://github.com/acme/repo.git");
  remoteByRoot.set(scratch, "https://github.com/acme/repo.git");

  const first = await provisioning.findOrCreateProjectForDirectory(work);
  const second = await provisioning.findOrCreateProjectForDirectory(scratch);

  // Distinct identities (repo roots), so neither add overwrites the other...
  expect(first.projectId).not.toBe(second.projectId);
  expect(first.rootPath).toBe(work);
  expect(second.rootPath).toBe(scratch);
  expect(await projectRegistry.list()).toHaveLength(2);
  // ...but both carry the shared remote key for cross-host grouping.
  expect(first.remoteKey).toBe("remote:github.com/acme/repo");
  expect(second.remoteKey).toBe("remote:github.com/acme/repo");
});

test("a worktree of a clone stays under that clone's project, not a sibling clone", async () => {
  const work = path.join(tmpDir, "work", "repo");
  gitRoots.add(work);
  remoteByRoot.set(work, "https://github.com/acme/repo.git");
  const root = await provisioning.findOrCreateProjectForDirectory(work);

  // A linked worktree of `work`: its own git root, but mainRepoRoot points back at
  // the main checkout, so it must group under `work`'s project.
  const worktree = path.join(tmpDir, "work", "repo-feature");
  gitRoots.add(worktree);
  remoteByRoot.set(worktree, "https://github.com/acme/repo.git");
  mainRepoRootByPath.set(worktree, work);

  const worktreeProject = await provisioning.findOrCreateProjectForDirectory(worktree);

  expect(worktreeProject.projectId).toBe(root.projectId);
  expect(await projectRegistry.list()).toHaveLength(1);
});

test("re-opening a legacy remote-keyed project by its root preserves its id (no migration)", async () => {
  const work = path.join(tmpDir, "work", "repo");
  gitRoots.add(work);
  remoteByRoot.set(work, "https://github.com/acme/repo.git");

  // Seed a pre-#987 record whose id is the remote key at this root.
  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "remote:github.com/acme/repo",
      rootPath: work,
      kind: "git",
      displayName: "acme/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );

  const resolved = await provisioning.findOrCreateProjectForDirectory(work);

  // Matched by rootPath, so its legacy id is preserved (workspaces/agents keyed to
  // it keep resolving) and the remote key is backfilled in place.
  expect(resolved.projectId).toBe("remote:github.com/acme/repo");
  expect(resolved.remoteKey).toBe("remote:github.com/acme/repo");
  expect(await projectRegistry.list()).toHaveLength(1);
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { resolveWorktreeRepositoryIdentity } from "./worktree-repository-identity.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createProjectRegistry(rootPath: string): Pick<ProjectRegistry, "get" | "list"> {
  const project = createPersistedProjectRecord({
    projectId: "prj_repo",
    rootPath,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    get: async (projectId) => (projectId === project.projectId ? project : null),
    list: async () => [project],
  };
}

function createProjectRegistryForProjects(
  projects: PersistedProjectRecord[],
): Pick<ProjectRegistry, "get" | "list"> {
  return {
    get: async (projectId) => projects.find((project) => project.projectId === projectId) ?? null,
    list: async () => projects,
  };
}

describe("resolveWorktreeRepositoryIdentity", () => {
  test("preserves the platform filesystem root", async () => {
    const filesystemRoot = parse(process.cwd()).root;

    await expect(
      resolveWorktreeRepositoryIdentity(
        { repoRoot: filesystemRoot },
        createProjectRegistry(filesystemRoot),
      ),
    ).resolves.toEqual({ projectId: "prj_repo", repoRoot: filesystemRoot });
  });

  test("resolves a registered daemon project from an explicit project ID", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    mkdirSync(repoRoot);

    await expect(
      resolveWorktreeRepositoryIdentity({ projectId: "prj_repo" }, createProjectRegistry(repoRoot)),
    ).resolves.toMatchObject({ projectId: "prj_repo", repoRoot: realpathSync.native(repoRoot) });
  });

  test("rejects missing, unregistered, traversing, and symlink-escape roots", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    const outsideRoot = join(tempDir, "outside");
    mkdirSync(repoRoot);
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, join(repoRoot, "escape"));
    const projects = createProjectRegistry(repoRoot);

    await expect(resolveWorktreeRepositoryIdentity({}, projects)).rejects.toThrow("required");
    await expect(
      resolveWorktreeRepositoryIdentity({ repoRoot: join(tempDir, "missing") }, projects),
    ).rejects.toThrow("must be an existing absolute path");
    await expect(
      resolveWorktreeRepositoryIdentity({ repoRoot: join(repoRoot, "..", "outside") }, projects),
    ).rejects.toThrow("does not identify");
    await expect(
      resolveWorktreeRepositoryIdentity({ repoRoot: join(repoRoot, "escape") }, projects),
    ).rejects.toThrow("does not identify");
  });

  test("rejects project and root identities that select different projects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    const anotherRoot = join(tempDir, "another");
    mkdirSync(repoRoot);
    mkdirSync(anotherRoot);

    await expect(
      resolveWorktreeRepositoryIdentity(
        { projectId: "prj_repo", repoRoot: anotherRoot },
        createProjectRegistry(repoRoot),
      ),
    ).rejects.toThrow("do not identify");
  });

  test("preserves explicit identity and rejects ambiguous canonical aliases", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    const repoAlias = join(tempDir, "repo-alias");
    mkdirSync(repoRoot);
    symlinkSync(repoRoot, repoAlias);
    const projects = createProjectRegistryForProjects([
      createPersistedProjectRecord({
        projectId: "prj_repo",
        rootPath: repoRoot,
        kind: "git",
        displayName: "repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createPersistedProjectRecord({
        projectId: "prj_repo_alias",
        rootPath: repoAlias,
        kind: "git",
        displayName: "repo alias",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    await expect(
      resolveWorktreeRepositoryIdentity({ repoRoot: repoAlias }, projects),
    ).resolves.toEqual({
      projectId: "prj_repo_alias",
      repoRoot: realpathSync.native(repoRoot),
    });
    await expect(
      resolveWorktreeRepositoryIdentity(
        { projectId: "prj_repo_alias", repoRoot: `${repoRoot}/.` },
        projects,
      ),
    ).resolves.toEqual({
      projectId: "prj_repo_alias",
      repoRoot: realpathSync.native(repoRoot),
    });
    await expect(
      resolveWorktreeRepositoryIdentity({ repoRoot: `${repoRoot}/.` }, projects),
    ).rejects.toThrow("multiple active daemon projects");
  });

  test("resolves legacy paths only through active workspaces and known worktrees", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    const workspaceCwd = join(repoRoot, "packages", "app");
    const knownWorktree = join(tempDir, "known-worktree");
    const unrelatedPath = join(tempDir, "unrelated");
    mkdirSync(workspaceCwd, { recursive: true });
    mkdirSync(knownWorktree);
    mkdirSync(unrelatedPath);
    const projects = createProjectRegistry(repoRoot);
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_repo",
      projectId: "prj_repo",
      cwd: workspaceCwd,
      kind: "local_checkout",
      displayName: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const workspaceRegistry: Pick<WorkspaceRegistry, "list"> = {
      list: async () => [workspace],
    };
    const listWorktrees = vi.fn(async () => [
      { path: knownWorktree, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const legacyDependencies = {
      workspaceRegistry,
      workspaceGitService: { listWorktrees } as Pick<WorkspaceGitService, "listWorktrees">,
    };

    await expect(
      resolveWorktreeRepositoryIdentity({ cwd: workspaceCwd }, projects, legacyDependencies),
    ).resolves.toEqual({ projectId: "prj_repo", repoRoot: realpathSync.native(repoRoot) });
    await expect(
      resolveWorktreeRepositoryIdentity(
        { worktreePath: knownWorktree },
        projects,
        legacyDependencies,
      ),
    ).resolves.toEqual({ projectId: "prj_repo", repoRoot: realpathSync.native(repoRoot) });
    await expect(
      resolveWorktreeRepositoryIdentity({ cwd: unrelatedPath }, projects, legacyDependencies),
    ).rejects.toThrow("does not identify");
    expect(listWorktrees).toHaveBeenCalledWith(realpathSync.native(repoRoot), {
      force: true,
      reason: "legacy-worktree-repository-identity",
    });
    expect(listWorktrees).not.toHaveBeenCalledWith(unrelatedPath, expect.anything());
  });

  test("resolves a legacy cwd to the deepest containing registered project", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    const nestedRoot = join(repoRoot, "packages", "app");
    const requestedCwd = join(nestedRoot, "src");
    mkdirSync(requestedCwd, { recursive: true });
    const projects = createProjectRegistryForProjects([
      createPersistedProjectRecord({
        projectId: "prj_outer",
        rootPath: repoRoot,
        kind: "git",
        displayName: "repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createPersistedProjectRecord({
        projectId: "prj_nested",
        rootPath: nestedRoot,
        kind: "non_git",
        displayName: "app",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const listWorktrees = vi.fn(async () => []);

    await expect(
      resolveWorktreeRepositoryIdentity({ cwd: requestedCwd }, projects, {
        workspaceRegistry: { list: async () => [] },
        workspaceGitService: { listWorktrees },
      }),
    ).resolves.toEqual({
      projectId: "prj_nested",
      repoRoot: realpathSync.native(nestedRoot),
    });
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  test("rejects equal-depth canonical project matches for a legacy cwd", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-repository-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = join(tempDir, "repo");
    const repoAlias = join(tempDir, "repo-alias");
    const requestedCwd = join(repoRoot, "packages", "app");
    mkdirSync(requestedCwd, { recursive: true });
    symlinkSync(repoRoot, repoAlias);
    const projects = createProjectRegistryForProjects([
      createPersistedProjectRecord({
        projectId: "prj_repo",
        rootPath: repoRoot,
        kind: "git",
        displayName: "repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createPersistedProjectRecord({
        projectId: "prj_alias",
        rootPath: repoAlias,
        kind: "git",
        displayName: "repo alias",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    await expect(
      resolveWorktreeRepositoryIdentity({ cwd: requestedCwd }, projects, {
        workspaceRegistry: { list: async () => [] },
        workspaceGitService: { listWorktrees: vi.fn(async () => []) },
      }),
    ).rejects.toThrow("multiple equally deep active daemon projects");
  });
});

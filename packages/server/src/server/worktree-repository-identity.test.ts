import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createPersistedProjectRecord,
  type PersistedProjectRecord,
  type ProjectRegistry,
} from "./workspace-registry.js";
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

  test("prefers an exact lexical root and rejects ambiguous canonical aliases", async () => {
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
      resolveWorktreeRepositoryIdentity({ repoRoot: `${repoRoot}/.` }, projects),
    ).rejects.toThrow("multiple active daemon projects");
  });
});

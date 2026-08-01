import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { resolveWorktreeRepositoryIdentity } from "./repository-identity.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLocalClient(projects: Array<{ projectId: string; projectRootPath: string }> = []) {
  return {
    getLastServerInfoMessage: () => ({ hostname: hostname() }),
    isLocalDaemonConnection: () => true,
    listProjects: async () => ({ projects }),
  };
}

function createRemoteClient(options?: { hostname?: string }) {
  return {
    getLastServerInfoMessage: () => ({ hostname: options?.hostname ?? "other-host" }),
    isLocalDaemonConnection: () => false,
    listProjects: async () => {
      throw new Error("Remote identity must not list local projects");
    },
  };
}

function createGitRepository(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("resolveWorktreeRepositoryIdentity", () => {
  test("uses an explicit daemon project without consulting the caller cwd", async () => {
    const identity = await resolveWorktreeRepositoryIdentity(
      { project: "prj_remote" },
      createRemoteClient(),
    );

    expect(identity).toEqual({ projectId: "prj_remote" });
  });

  test("requires explicit identity for a remote daemon", async () => {
    await expect(resolveWorktreeRepositoryIdentity({}, createRemoteClient())).rejects.toMatchObject(
      { code: "REPOSITORY_IDENTITY_REQUIRED" },
    );
  });

  test("does not infer the caller cwd for a remote connection with the same hostname", async () => {
    await expect(
      resolveWorktreeRepositoryIdentity(
        { host: "remote.example" },
        createRemoteClient({ hostname: hostname() }),
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_IDENTITY_REQUIRED" });
  });

  test("does not infer the caller cwd for an empty host option that falls back to remote", async () => {
    await expect(
      resolveWorktreeRepositoryIdentity({ host: "" }, createRemoteClient({ hostname: hostname() })),
    ).rejects.toMatchObject({ code: "REPOSITORY_IDENTITY_REQUIRED" });
  });

  test("defaults to the local Git root only after local connection and same-host proof", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");

    const identity = await resolveWorktreeRepositoryIdentity({}, createLocalClient(), repoRoot);

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("resolves the Git top-level for a verified local nested cwd", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "packages", "cli");
    mkdirSync(nested, { recursive: true });

    const identity = await resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("preserves an exactly registered monorepo subproject", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const subprojectRoot = join(repoRoot, "packages", "service");
    mkdirSync(subprojectRoot, { recursive: true });

    const identity = await resolveWorktreeRepositoryIdentity(
      {},
      createLocalClient([
        { projectId: "prj_repo", projectRootPath: repoRoot },
        { projectId: "prj_service", projectRootPath: subprojectRoot },
      ]),
      subprojectRoot,
    );

    expect(identity).toEqual({
      projectId: "prj_service",
      repoRoot: realpathSync.native(subprojectRoot),
    });
  });

  test("selects the deepest registered project containing the caller cwd", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const subprojectRoot = join(repoRoot, "packages", "service");
    const nested = join(subprojectRoot, "src");
    mkdirSync(nested, { recursive: true });

    const identity = await resolveWorktreeRepositoryIdentity(
      {},
      createLocalClient([
        { projectId: "prj_service", projectRootPath: subprojectRoot },
        { projectId: "prj_repo", projectRootPath: repoRoot },
      ]),
      nested,
    );

    expect(identity).toEqual({
      projectId: "prj_service",
      repoRoot: realpathSync.native(subprojectRoot),
    });
  });

  test("rejects duplicate canonical project roots while preserving explicit identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "packages", "service");
    const firstAlias = join(tempDir, "repo-alias-first");
    const secondAlias = join(tempDir, "repo-alias-second");
    mkdirSync(nested, { recursive: true });
    symlinkSync(repoRoot, firstAlias);
    symlinkSync(repoRoot, secondAlias);
    const client = createLocalClient([
      { projectId: "prj_first", projectRootPath: firstAlias },
      { projectId: "prj_second", projectRootPath: secondAlias },
    ]);

    await expect(resolveWorktreeRepositoryIdentity({}, client, nested)).rejects.toMatchObject({
      code: "AMBIGUOUS_REPOSITORY_IDENTITY",
    });
    await expect(
      resolveWorktreeRepositoryIdentity({ project: "prj_second" }, client, nested),
    ).resolves.toEqual({ projectId: "prj_second" });
  });

  test("resolves a linked worktree through its registered main repository", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repoRoot });
    const worktreeRoot = join(tempDir, "linked-worktree");
    execFileSync("git", ["worktree", "add", "-b", "feature", worktreeRoot], { cwd: repoRoot });

    const identity = await resolveWorktreeRepositoryIdentity(
      {},
      createLocalClient([{ projectId: "prj_repo", projectRootPath: repoRoot }]),
      worktreeRoot,
    );

    expect(identity).toEqual({
      projectId: "prj_repo",
      repoRoot: realpathSync.native(repoRoot),
    });
  });

  test("preserves a registered monorepo subproject from a linked worktree", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repoRoot });
    const sourceProjectRoot = join(repoRoot, "packages", "service");
    mkdirSync(sourceProjectRoot, { recursive: true });
    const worktreeRoot = join(tempDir, "linked-worktree");
    execFileSync("git", ["worktree", "add", "-b", "nested-feature", worktreeRoot], {
      cwd: repoRoot,
    });
    const linkedProjectCwd = join(worktreeRoot, "packages", "service", "src");
    mkdirSync(linkedProjectCwd, { recursive: true });

    const identity = await resolveWorktreeRepositoryIdentity(
      {},
      createLocalClient([
        { projectId: "prj_repo", projectRootPath: repoRoot },
        { projectId: "prj_service", projectRootPath: sourceProjectRoot },
      ]),
      linkedProjectCwd,
    );

    expect(identity).toEqual({
      projectId: "prj_service",
      repoRoot: realpathSync.native(sourceProjectRoot),
    });
  });

  test("selects the innermost Git root when repositories are nested", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const outerRoot = createGitRepository(tempDir, "outer");
    const innerRoot = createGitRepository(outerRoot, "inner");
    const nested = join(innerRoot, "src");
    mkdirSync(nested);

    const identity = await resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: realpathSync.native(innerRoot) });
  });

  test("does not let a registered outer project shadow an independent inner repository", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const outerRoot = createGitRepository(tempDir, "outer");
    const innerRoot = createGitRepository(outerRoot, "inner");
    const nested = join(innerRoot, "src");
    mkdirSync(nested);

    const identity = await resolveWorktreeRepositoryIdentity(
      {},
      createLocalClient([{ projectId: "prj_outer", projectRootPath: outerRoot }]),
      nested,
    );

    expect(identity).toEqual({ repoRoot: realpathSync.native(innerRoot) });
  });

  test("uses Git's canonical top-level for a nested cwd reached through a symlink", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "src");
    const alias = join(tempDir, "repo-alias");
    mkdirSync(nested);
    symlinkSync(repoRoot, alias);

    const identity = await resolveWorktreeRepositoryIdentity(
      {},
      createLocalClient(),
      join(alias, "src"),
    );

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("preserves trailing whitespace in the Git top-level", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo ");
    const nested = join(repoRoot, "src");
    mkdirSync(nested);

    const identity = await resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("keeps an exact cwd when the verified local directory is not in Git", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const nested = join(tempDir, "plain", "nested");
    mkdirSync(nested, { recursive: true });

    const identity = await resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: nested });
  });

  test("does not rewrite an explicit root through local Git discovery", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "src");
    mkdirSync(nested);

    const identity = await resolveWorktreeRepositoryIdentity(
      { repoRoot: nested },
      createLocalClient(),
      nested,
    );

    expect(identity).toEqual({ repoRoot: nested });
  });

  test("treats the deprecated cwd option as an explicit repository root", async () => {
    const identity = await resolveWorktreeRepositoryIdentity(
      { cwd: "/srv/repo" },
      createRemoteClient(),
    );

    expect(identity).toEqual({ repoRoot: "/srv/repo" });
  });

  test("refuses a remote endpoint even when the caller cwd is nested in Git", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "src");
    mkdirSync(nested);

    await expect(
      resolveWorktreeRepositoryIdentity({}, createRemoteClient({ hostname: hostname() }), nested),
    ).rejects.toMatchObject({ code: "REPOSITORY_IDENTITY_REQUIRED" });
  });

  test("rejects conflicting identity flags", async () => {
    await expect(
      resolveWorktreeRepositoryIdentity(
        { project: "prj_remote", repoRoot: "/srv/repo" },
        createRemoteClient(),
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_REPOSITORY_IDENTITY" });
    await expect(
      resolveWorktreeRepositoryIdentity(
        { repoRoot: "/srv/repo", cwd: "/srv/other" },
        createRemoteClient(),
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_REPOSITORY_IDENTITY" });
  });
});

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

function createLocalClient() {
  return {
    getLastServerInfoMessage: () => ({ hostname: hostname() }),
    isLocalDaemonConnection: () => true,
  };
}

function createGitRepository(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("resolveWorktreeRepositoryIdentity", () => {
  test("uses an explicit daemon project without consulting the caller cwd", () => {
    const identity = resolveWorktreeRepositoryIdentity(
      { project: "prj_remote" },
      { getLastServerInfoMessage: () => null, isLocalDaemonConnection: () => false },
    );

    expect(identity).toEqual({ projectId: "prj_remote" });
  });

  test("requires explicit identity for a remote daemon", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        {},
        {
          getLastServerInfoMessage: () => ({ hostname: "other-host" }),
          isLocalDaemonConnection: () => false,
        },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("does not infer the caller cwd for a remote connection with the same hostname", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { host: "remote.example" },
        {
          getLastServerInfoMessage: () => ({ hostname: hostname() }),
          isLocalDaemonConnection: () => false,
        },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("does not infer the caller cwd for an empty host option that falls back to remote", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { host: "" },
        {
          getLastServerInfoMessage: () => ({ hostname: hostname() }),
          isLocalDaemonConnection: () => false,
        },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("defaults to the local Git root only after local connection and same-host proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");

    const identity = resolveWorktreeRepositoryIdentity(
      {},
      {
        getLastServerInfoMessage: () => ({ hostname: hostname() }),
        isLocalDaemonConnection: () => true,
      },
      repoRoot,
    );

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("resolves the Git top-level for a verified local nested cwd", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "packages", "cli");
    mkdirSync(nested, { recursive: true });

    const identity = resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("selects the innermost Git root when repositories are nested", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const outerRoot = createGitRepository(tempDir, "outer");
    const innerRoot = createGitRepository(outerRoot, "inner");
    const nested = join(innerRoot, "src");
    mkdirSync(nested);

    const identity = resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: realpathSync.native(innerRoot) });
  });

  test("uses Git's canonical top-level for a nested cwd reached through a symlink", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "src");
    const alias = join(tempDir, "repo-alias");
    mkdirSync(nested);
    symlinkSync(repoRoot, alias);

    const identity = resolveWorktreeRepositoryIdentity({}, createLocalClient(), join(alias, "src"));

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("preserves trailing whitespace in the Git top-level", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo ");
    const nested = join(repoRoot, "src");
    mkdirSync(nested);

    const identity = resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: realpathSync.native(repoRoot) });
  });

  test("keeps an exact cwd when the verified local directory is not in Git", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const nested = join(tempDir, "plain", "nested");
    mkdirSync(nested, { recursive: true });

    const identity = resolveWorktreeRepositoryIdentity({}, createLocalClient(), nested);

    expect(identity).toEqual({ repoRoot: nested });
  });

  test("does not rewrite an explicit root through local Git discovery", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "src");
    mkdirSync(nested);

    const identity = resolveWorktreeRepositoryIdentity(
      { repoRoot: nested },
      createLocalClient(),
      nested,
    );

    expect(identity).toEqual({ repoRoot: nested });
  });

  test("refuses a remote endpoint even when the caller cwd is nested in Git", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-identity-"));
    cleanupPaths.push(tempDir);
    const repoRoot = createGitRepository(tempDir, "repo");
    const nested = join(repoRoot, "src");
    mkdirSync(nested);

    expect(() => {
      resolveWorktreeRepositoryIdentity(
        {},
        {
          getLastServerInfoMessage: () => ({ hostname: hostname() }),
          isLocalDaemonConnection: () => false,
        },
        nested,
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("rejects conflicting identity flags", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { project: "prj_remote", repoRoot: "/srv/repo" },
        { getLastServerInfoMessage: () => null, isLocalDaemonConnection: () => false },
      );
    }).toThrow(expect.objectContaining({ code: "AMBIGUOUS_REPOSITORY_IDENTITY" }));
  });
});

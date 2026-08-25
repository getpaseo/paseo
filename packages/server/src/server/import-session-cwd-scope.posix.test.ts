import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { normalizePathForIdentity } from "../utils/path.js";
import {
  createImportSessionCwdScopeResolver,
  ImportSessionCwdScopeError,
} from "./import-session-cwd-scope.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("import session cwd scope", () => {
  let tempRoot: string;
  let gitService: WorkspaceGitServiceImpl;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "import-session-cwd-scope-"));
    gitService = new WorkspaceGitServiceImpl({
      logger: createTestLogger(),
      paseoHome: join(tempRoot, "paseo-home"),
    });
  });

  afterEach(() => {
    gitService.dispose();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("maps an exact selected subdirectory across arbitrary linked worktree names", async () => {
    const repo = createRepository(join(tempRoot, "main", "lpu-monorepo"));
    const selectedRoot = join(repo, "packages", "compiler");
    const codexWorktree = join(tempRoot, ".codex", "worktrees", "a227", "unexpected-name");
    const paseoWorktree = join(tempRoot, ".paseo", "worktrees", "hash", "military-elephant");
    addWorktree(repo, codexWorktree, "codex-feature");
    addWorktree(repo, paseoWorktree, "paseo-feature");
    const independentClone = join(tempRoot, "independent", "lpu-monorepo");
    git(["clone", repo, independentClone], tempRoot);

    const scope = await createResolver(gitService).resolve(selectedRoot);

    expect(scope.sourceCwd).toBe(selectedRoot);
    await expect(scope.matchesCwd(selectedRoot)).resolves.toBe(true);
    await expect(scope.matchesCwd(join(codexWorktree, "packages", "compiler"))).resolves.toBe(true);
    await expect(scope.matchesCwd(join(paseoWorktree, "packages", "compiler"))).resolves.toBe(true);
    await expect(scope.matchesCwd(repo)).resolves.toBe(false);
    await expect(scope.matchesCwd(join(selectedRoot, "src"))).resolves.toBe(false);
    await expect(scope.matchesCwd(join(independentClone, "packages", "compiler"))).resolves.toBe(
      false,
    );
    expect(scope.exactCwds).toHaveLength(3);
  });

  test("excludes missing, nested-repository, and symlinked-independent mapped directories", async () => {
    const repo = createRepository(join(tempRoot, "repo"));
    const selectedRoot = join(repo, "packages", "compiler");
    const missingWorktree = join(tempRoot, "linked", "missing");
    const nestedWorktree = join(tempRoot, "linked", "nested");
    const symlinkWorktree = join(tempRoot, "linked", "symlink");
    addWorktree(repo, missingWorktree, "missing-feature");
    addWorktree(repo, nestedWorktree, "nested-feature");
    addWorktree(repo, symlinkWorktree, "symlink-feature");

    rmSync(join(missingWorktree, "packages", "compiler"), { recursive: true, force: true });

    const nestedRoot = join(nestedWorktree, "packages", "compiler");
    rmSync(nestedRoot, { recursive: true, force: true });
    mkdirSync(nestedRoot, { recursive: true });
    git(["init", "-b", "main"], nestedRoot);

    const independent = createRepository(join(tempRoot, "independent"));
    const symlinkRoot = join(symlinkWorktree, "packages", "compiler");
    rmSync(symlinkRoot, { recursive: true, force: true });
    symlinkSync(independent, symlinkRoot, "dir");

    const scope = await createResolver(gitService).resolve(selectedRoot);

    expect(scope.exactCwds.map(normalizePathForIdentity)).toEqual([
      normalizePathForIdentity(selectedRoot),
    ]);
    await expect(scope.matchesCwd(join(missingWorktree, "packages", "compiler"))).resolves.toBe(
      false,
    );
    await expect(scope.matchesCwd(nestedRoot)).resolves.toBe(false);
    await expect(scope.matchesCwd(symlinkRoot)).resolves.toBe(false);
  });

  test("drops deleted prunable worktrees and refreshes the cached linked set on forced import", async () => {
    const repo = createRepository(join(tempRoot, "repo"));
    const selectedRoot = join(repo, "packages", "compiler");
    const deletedWorktree = join(tempRoot, "linked", "deleted");
    addWorktree(repo, deletedWorktree, "deleted-feature");
    rmSync(deletedWorktree, { recursive: true, force: true });

    const resolver = createResolver(gitService);
    const initial = await resolver.resolve(selectedRoot);
    expect(initial.exactCwds.map(normalizePathForIdentity)).toEqual([
      normalizePathForIdentity(selectedRoot),
    ]);

    const laterWorktree = join(tempRoot, "linked", "later");
    addWorktree(repo, laterWorktree, "later-feature");
    const cached = await resolver.resolve(selectedRoot);
    await expect(cached.matchesCwd(join(laterWorktree, "packages", "compiler"))).resolves.toBe(
      false,
    );

    const fresh = await resolver.resolve(selectedRoot, {
      force: true,
      reason: "provider-session-import",
    });
    await expect(fresh.matchesCwd(join(laterWorktree, "packages", "compiler"))).resolves.toBe(true);
  });

  test("excludes a bare repository entry from the linked worktree set", async () => {
    const seed = createRepository(join(tempRoot, "seed"));
    const bare = join(tempRoot, "repo.git");
    git(["clone", "--bare", seed, bare], tempRoot);
    const linked = join(tempRoot, "linked", "checkout");
    mkdirSync(join(linked, ".."), { recursive: true });
    git([`--git-dir=${bare}`, "worktree", "add", linked, "main"], tempRoot);

    const identities = await gitService.listLinkedWorktrees(linked);

    expect(identities.map((identity) => normalizePathForIdentity(identity.worktreeRoot))).toEqual([
      normalizePathForIdentity(linked),
    ]);
    expect(
      identities.some(
        (identity) =>
          normalizePathForIdentity(identity.worktreeRoot) === normalizePathForIdentity(bare),
      ),
    ).toBe(false);
  });

  test("uses one exact root outside Git and rejects an unavailable source directory", async () => {
    const plainRoot = join(tempRoot, "plain");
    const aliasRoot = join(tempRoot, "plain-alias");
    mkdirSync(plainRoot, { recursive: true });
    symlinkSync(plainRoot, aliasRoot, "dir");
    const resolver = createResolver(gitService);

    const scope = await resolver.resolve(plainRoot);
    await expect(scope.matchesCwd(plainRoot)).resolves.toBe(true);
    await expect(scope.matchesCwd(aliasRoot)).resolves.toBe(true);
    await expect(scope.matchesCwd(join(plainRoot, "child"))).resolves.toBe(false);
    await expect(
      resolver.resolve(join(tempRoot, "missing")),
    ).rejects.toMatchObject<ImportSessionCwdScopeError>({
      code: "unavailable_source_cwd",
    });
  });
});

function createResolver(gitService: WorkspaceGitServiceImpl) {
  return createImportSessionCwdScopeResolver({ workspaceGitService: gitService });
}

function createRepository(repo: string): string {
  mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Paseo Test"], repo);
  mkdirSync(join(repo, "packages", "compiler", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "compiler", "README.md"), "compiler\n");
  git(["add", "."], repo);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], repo);
  return repo;
}

function addWorktree(repo: string, worktree: string, branch: string): void {
  mkdirSync(join(worktree, ".."), { recursive: true });
  git(["worktree", "add", "-b", branch, worktree], repo);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

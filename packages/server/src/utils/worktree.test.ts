import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree,
  deletePaseoWorktree,
  ensurePaseoIgnored,
  isPaseoOwnedWorktreeCwd,
  listPaseoWorktrees,
  slugify,
} from "./worktree";
import { getPaseoWorktreeMetadataPath } from "./worktree-metadata.js";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("createWorktree", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    // Create a git repo with an initial commit
    execSync(`mkdir -p ${repoDir}`);
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test'", { cwd: repoDir });
    execSync("echo 'hello' > file.txt", { cwd: repoDir });
    execSync("git add .", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a worktree for the current branch (main)", async () => {
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "hello-world",
      paseoHome,
    });

    expect(result.worktreePath).toBe(
      join(paseoHome, "worktrees", "test-repo", "hello-world")
    );
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
    const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf8")
    );
    expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
  });

  it("detects paseo-owned worktrees across realpath differences (macOS /var vs /private/var)", async () => {
    // Intentionally create repo using the non-realpath tmpdir() variant (often /var/... on macOS).
    const varTempDir = mkdtempSync(join(tmpdir(), "worktree-realpath-test-"));
    const privateTempDir = realpathSync(varTempDir);
    const varRepoDir = join(varTempDir, "test-repo");
    const varPaseoHome = join(varTempDir, "paseo-home");
    execSync(`mkdir -p ${varRepoDir}`);
    execSync("git init -b main", { cwd: varRepoDir });
    execSync("git config user.email 'test@test.com'", { cwd: varRepoDir });
    execSync("git config user.name 'Test'", { cwd: varRepoDir });
    execSync("echo 'hello' > file.txt", { cwd: varRepoDir });
    execSync("git add .", { cwd: varRepoDir });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: varRepoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: varRepoDir,
      baseBranch: "main",
      worktreeSlug: "realpath-test",
      paseoHome: varPaseoHome,
    });

    const privateWorktreePath = join(privateTempDir, "paseo-home", "worktrees", "test-repo", "realpath-test");
    expect(existsSync(privateWorktreePath)).toBe(true);

    const ownership = await isPaseoOwnedWorktreeCwd(privateWorktreePath, { paseoHome: varPaseoHome });
    expect(ownership.allowed).toBe(true);

    rmSync(varTempDir, { recursive: true, force: true });
  });

  it("creates a worktree with a new branch", async () => {
    const result = await createWorktree({
      branchName: "feature-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "my-feature",
      paseoHome,
    });

    expect(result.worktreePath).toBe(
      join(paseoHome, "worktrees", "test-repo", "my-feature")
    );
    expect(existsSync(result.worktreePath)).toBe(true);

    // Verify branch was created
    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("feature-branch");
    const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf8")
    );
    expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
  });

  it("fails with invalid branch name", async () => {
    await expect(
      createWorktree({
        branchName: "INVALID_UPPERCASE",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "test",
      })
    ).rejects.toThrow("Invalid branch name");
  });

  it("handles branch name collision by adding suffix", async () => {
    // Create a branch named "hello" first
    execSync("git branch hello", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "hello",
      paseoHome,
    });

    // Should create branch "hello-1" since "hello" exists
    expect(result.worktreePath).toBe(
      join(paseoHome, "worktrees", "test-repo", "hello")
    );
    expect(existsSync(result.worktreePath)).toBe(true);

    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("hello-1");
  });

  it("handles multiple collisions", async () => {
    // Create branches "hello" and "hello-1"
    execSync("git branch hello", { cwd: repoDir });
    execSync("git branch hello-1", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "hello",
      paseoHome,
    });

    expect(existsSync(result.worktreePath)).toBe(true);

    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("hello-2");
  });

  it("runs setup commands from paseo.json", async () => {
    // Create paseo.json with setup commands
    const paseoConfig = {
      worktree: {
        setup: [
          'echo "root=$PASEO_ROOT_PATH" > setup.log',
          'echo "worktree=$PASEO_WORKTREE_PATH" >> setup.log',
          'echo "branch=$PASEO_BRANCH_NAME" >> setup.log',
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync("git add paseo.json && git -c commit.gpgsign=false commit -m 'add paseo.json'", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "setup-test",
      paseoHome,
    });

    expect(existsSync(result.worktreePath)).toBe(true);

    // Verify setup ran and env vars were available
    const setupLog = readFileSync(join(result.worktreePath, "setup.log"), "utf8");
    expect(setupLog).toContain(`root=${repoDir}`);
    expect(setupLog).toContain(`worktree=${result.worktreePath}`);
    expect(setupLog).toContain("branch=setup-test");
  });

  it("does not run setup commands when runSetup=false", async () => {
    const paseoConfig = {
      worktree: {
        setup: ['echo "setup ran" > setup.log'],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync(
      "git add paseo.json && git -c commit.gpgsign=false commit -m 'add paseo.json'",
      { cwd: repoDir }
    );

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "no-setup-test",
      runSetup: false,
      paseoHome,
    });

    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, "setup.log"))).toBe(false);
  });

  it("cleans up worktree if setup command fails", async () => {
    // Create paseo.json with failing setup command
    const paseoConfig = {
      worktree: {
        setup: ["exit 1"],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync("git add paseo.json && git -c commit.gpgsign=false commit -m 'add paseo.json'", { cwd: repoDir });

    const expectedWorktreePath = join(
      paseoHome,
      "worktrees",
      "test-repo",
      "fail-test"
    );

    await expect(
      createWorktree({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "fail-test",
        paseoHome,
      })
    ).rejects.toThrow("Worktree setup command failed");

    // Verify worktree was cleaned up
    expect(existsSync(expectedWorktreePath)).toBe(false);
  });
});

describe("paseo worktree manager", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    execSync(`mkdir -p ${repoDir}`);
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test'", { cwd: repoDir });
    execSync("echo 'hello' > file.txt", { cwd: repoDir });
    execSync("git add .", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists and deletes paseo worktrees under ~/.paseo/worktrees/{project}", async () => {
    const first = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });
    const second = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "beta",
      paseoHome,
    });

    const worktrees = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    const paths = worktrees.map((worktree) => worktree.path).sort();
    expect(paths).toEqual([first.worktreePath, second.worktreePath].sort());

    await deletePaseoWorktree({ cwd: repoDir, worktreePath: first.worktreePath, paseoHome });
    expect(existsSync(first.worktreePath)).toBe(false);

    const remaining = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    expect(remaining.map((worktree) => worktree.path)).toEqual([second.worktreePath]);
  });

  it("deletes a paseo worktree even when given a subdirectory path", async () => {
    const created = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });

    const nestedDir = join(created.worktreePath, "nested", "dir");
    execSync(`mkdir -p ${nestedDir}`);

    await deletePaseoWorktree({ cwd: repoDir, worktreePath: nestedDir, paseoHome });
    expect(existsSync(created.worktreePath)).toBe(false);

    const remaining = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    expect(remaining.some((worktree) => worktree.path === created.worktreePath)).toBe(false);
  });

  it("ensures .paseo is ignored in .gitignore", async () => {
    await ensurePaseoIgnored(repoDir);
    await ensurePaseoIgnored(repoDir);

    const gitignorePath = join(repoDir, ".gitignore");
    const gitignore = readFileSync(gitignorePath, "utf8");
    const matches = gitignore.match(/^\.paseo\/?$/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("slugify", () => {
  it("converts to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("FOO_BAR")).toBe("foo-bar");
  });

  it("truncates long strings at word boundary", () => {
    const longInput = "https-stackoverflow-com-questions-68349031-only-run-actions-on-non-draft-pull-request";
    const result = slugify(longInput);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toBe("https-stackoverflow-com-questions-68349031-only");
  });

  it("truncates without trailing hyphen when no word boundary", () => {
    const longInput = "a".repeat(60);
    const result = slugify(longInput);
    expect(result.length).toBe(50);
    expect(result.endsWith("-")).toBe(false);
  });
});

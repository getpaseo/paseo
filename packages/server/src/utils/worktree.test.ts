import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWorktree, slugify } from "./worktree";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("createWorktree", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
    repoDir = join(tempDir, "test-repo");

    // Create a git repo with an initial commit
    execSync(`mkdir -p ${repoDir}`);
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test'", { cwd: repoDir });
    execSync("echo 'hello' > file.txt", { cwd: repoDir });
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'initial'", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a worktree for the current branch (main)", async () => {
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      worktreeSlug: "hello-world",
    });

    expect(result.worktreePath).toBe(join(tempDir, "test-repo-hello-world"));
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
  });

  it("creates a worktree with a new branch", async () => {
    const result = await createWorktree({
      branchName: "feature-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "my-feature",
    });

    expect(result.worktreePath).toBe(join(tempDir, "test-repo-my-feature"));
    expect(existsSync(result.worktreePath)).toBe(true);

    // Verify branch was created
    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("feature-branch");
  });

  it("fails with invalid branch name", async () => {
    await expect(
      createWorktree({
        branchName: "INVALID_UPPERCASE",
        cwd: repoDir,
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
      worktreeSlug: "hello",
    });

    // Should create branch "hello-1" since "hello" exists
    expect(result.worktreePath).toBe(join(tempDir, "test-repo-hello"));
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
      worktreeSlug: "hello",
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
    execSync("git add paseo.json && git commit -m 'add paseo.json'", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      worktreeSlug: "setup-test",
    });

    expect(existsSync(result.worktreePath)).toBe(true);

    // Verify setup ran and env vars were available
    const setupLog = readFileSync(join(result.worktreePath, "setup.log"), "utf8");
    expect(setupLog).toContain(`root=${repoDir}`);
    expect(setupLog).toContain(`worktree=${result.worktreePath}`);
    expect(setupLog).toContain("branch=setup-test");
  });

  it("cleans up worktree if setup command fails", async () => {
    // Create paseo.json with failing setup command
    const paseoConfig = {
      worktree: {
        setup: ["exit 1"],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync("git add paseo.json && git commit -m 'add paseo.json'", { cwd: repoDir });

    const expectedWorktreePath = join(tempDir, "test-repo-fail-test");

    await expect(
      createWorktree({
        branchName: "main",
        cwd: repoDir,
        worktreeSlug: "fail-test",
      })
    ).rejects.toThrow("Worktree setup command failed");

    // Verify worktree was cleaned up
    expect(existsSync(expectedWorktreePath)).toBe(false);
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

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.1-codex-mini with low reasoning effort for faster test execution
const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("getGitDiff", () => {
    test(
      "returns diff for modified file in git repo",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "original content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
          cwd,
          stdio: "pipe",
        });

        // Modify the file (creates unstaged changes)
        writeFileSync(testFile, "modified content\n");

        // Create agent in the git repo
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Git Diff Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Get git diff
        const result = await ctx.client.getGitDiff(agent.id);

        // Verify diff returned without error
        expect(result.error).toBeNull();
        expect(result.diff).toBeTruthy();
        expect(result.diff).toContain("test.txt");
        expect(result.diff).toContain("-original content");
        expect(result.diff).toContain("+modified content");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns empty diff when no changes",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo with clean state
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
          cwd,
          stdio: "pipe",
        });

        // Create agent in the git repo (no modifications)
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Git Diff Clean Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git diff - should be empty
        const result = await ctx.client.getGitDiff(agent.id);

        expect(result.error).toBeNull();
        expect(result.diff).toBe("");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns error for non-git directory",
      async () => {
        const cwd = tmpCwd();
        // Don't initialize git - just a regular directory

        // Create agent in a non-git directory
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Git Diff Non-Git Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git diff - should return error
        const result = await ctx.client.getGitDiff(agent.id);

        expect(result.diff).toBe("");
        expect(result.error).toBeTruthy();
        expect(result.error).toContain("git");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });


  describe("getGitRepoInfo", () => {
    test(
      "returns repo info for git repo with branch and dirty state",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "original content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
          cwd,
          stdio: "pipe",
        });

        // Modify the file (makes repo dirty)
        writeFileSync(testFile, "modified content\n");

        // Create agent in the git repo
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Git Repo Info Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Get git repo info
        const result = await ctx.client.getGitRepoInfo(agent.id);

        // Verify repo info returned without error
        expect(result.error).toBeNull();
        // macOS symlinks /var to /private/var, so we check containment
        expect(result.repoRoot).toContain("daemon-e2e-");
        expect(result.currentBranch).toBeTruthy();
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.some((b) => b.isCurrent)).toBe(true);
        expect(result.isDirty).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns clean state when no uncommitted changes",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo with clean state
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file (no uncommitted changes)
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
          cwd,
          stdio: "pipe",
        });

        // Create agent in the git repo
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Git Repo Info Clean Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git repo info
        const result = await ctx.client.getGitRepoInfo(agent.id);

        expect(result.error).toBeNull();
        expect(result.isDirty).toBe(false);
        expect(result.currentBranch).toBeTruthy();

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns error for non-git directory",
      async () => {
        const cwd = tmpCwd();
        // Don't initialize git - just a regular directory

        // Create agent in a non-git directory
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Git Repo Info Non-Git Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git repo info - should return error
        const result = await ctx.client.getGitRepoInfo(agent.id);

        // Server returns cwd as repoRoot even on error, so we just check for error
        expect(result.error).toBeTruthy();

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });

  describe("createAgent with worktree", () => {
    test(
      "creates agent in .paseo/worktrees when worktree is requested",
      async () => {
        const cwd = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
          cwd,
          stdio: "pipe",
        });

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Worktree Agent Test",
          git: {
            createWorktree: true,
            createNewBranch: true,
            newBranchName: "worktree-test",
            worktreeSlug: "worktree-test",
          },
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");
        expect(realpathSync(agent.cwd)).toBe(
          realpathSync(path.join(cwd, ".paseo", "worktrees", "worktree-test"))
        );
        expect(existsSync(agent.cwd)).toBe(true);

        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );
  });


});

import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync, execSync, spawnSync } from "child_process";

import {
  createDaemonTestContext,
  createTempGithubRepoName,
  type DaemonTestContext,
} from "../test-utils/index.js";
import {
  createWorktree as createWorktreePrimitive,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "../../utils/worktree.js";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}

const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";
// Keep this checkout-ship-specific: broad real/e2e flags must never enable repository mutation.
const CHECKOUT_SHIP_LIVE_GITHUB_E2E = "PASEO_CHECKOUT_SHIP_LIVE_GITHUB_E2E";

interface GitHubCliAuthStatus {
  authenticated: boolean;
  canDeleteRepositories: boolean;
}

interface GitHubCliCommandResult {
  succeeded: boolean;
  output: string;
}

type GitHubCliCommandRunner = (args: string[]) => GitHubCliCommandResult;

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function getGitHubCliAuthStatus(): GitHubCliAuthStatus {
  const result = spawnSync("gh", ["auth", "status", "-h", "github.com"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  return {
    authenticated: result.status === 0,
    canDeleteRepositories: /token[- ]scopes?:[^\n]*\bdelete_repo\b/i.test(output),
  };
}

function shouldRunCheckoutShipLiveGitHubMutation(
  explicitOptIn: string | undefined,
  authStatus: GitHubCliAuthStatus,
): boolean {
  return explicitOptIn === "1" && authStatus.authenticated && authStatus.canDeleteRepositories;
}

function assertCheckoutShipLiveGitHubMutationEnabled(): void {
  const explicitOptIn = process.env[CHECKOUT_SHIP_LIVE_GITHUB_E2E];
  const authStatus = getGitHubCliAuthStatus();

  if (shouldRunCheckoutShipLiveGitHubMutation(explicitOptIn, authStatus)) {
    return;
  }

  const missingRequirements = [
    explicitOptIn === "1" ? null : `${CHECKOUT_SHIP_LIVE_GITHUB_E2E}=1`,
    authStatus.authenticated ? null : "authenticated gh CLI access to github.com",
    authStatus.canDeleteRepositories ? null : "the delete_repo scope required for cleanup",
  ].filter((requirement): requirement is string => requirement !== null);

  throw new Error(
    `Checkout ship live GitHub mutation is disabled; missing ${missingRequirements.join(
      ", ",
    )}. No remote repository was created.`,
  );
}

const testWithExplicitLiveGitHubOptIn =
  process.env[CHECKOUT_SHIP_LIVE_GITHUB_E2E] === "1" ? test : test.skip;

function initGitRepo(repoDir: string): void {
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'paseo-test@example.com'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git config user.name 'Paseo Test'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  writeFileSync(path.join(repoDir, "README.md"), "init\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
    cwd: repoDir,
    stdio: "pipe",
  });
}

function getGhLogin(): string {
  return execSync("gh api user --jq .login", { stdio: "pipe" }).toString().trim();
}

function createPrivateRepo(repoName: string): void {
  execSync(`gh api -X POST user/repos -f name=${repoName} -f private=true`, {
    stdio: "pipe",
  });
}

function getGhToken(): string {
  return execSync("gh auth token", { stdio: "pipe" }).toString().trim();
}

function formatCommandError(error: unknown): string {
  if (error && typeof error === "object") {
    const commandError = error as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    const output = [commandError.stderr, commandError.stdout]
      .map((value) => value?.toString().trim())
      .filter(Boolean)
      .join("\n");

    return output || commandError.message || String(error);
  }

  return String(error);
}

function runGitHubCli(args: string[]): GitHubCliCommandResult {
  try {
    const output = execFileSync("gh", args, { stdio: "pipe" }).toString().trim();
    return { succeeded: true, output };
  } catch (error) {
    return { succeeded: false, output: formatCommandError(error) };
  }
}

function deleteRepoAndVerifyAbsent(
  fullName: string | null,
  runGitHubCommand: GitHubCliCommandRunner = runGitHubCli,
): void {
  if (!fullName) {
    return;
  }

  const deleteResult = runGitHubCommand(["repo", "delete", fullName, "--yes"]);
  const readbackResult = runGitHubCommand(["api", `repos/${fullName}`]);
  const exactRepoIsAbsent =
    !readbackResult.succeeded && /\bHTTP 404\b/i.test(readbackResult.output);

  if (exactRepoIsAbsent) {
    return;
  }

  const deleteSummary = deleteResult.succeeded
    ? "gh repo delete reported success"
    : `gh repo delete failed: ${deleteResult.output}`;

  if (readbackResult.succeeded) {
    throw new Error(
      `Failed to clean up temporary GitHub repo ${fullName}: the exact repo remains readable after cleanup; ${deleteSummary}.`,
    );
  }

  throw new Error(
    `Failed to verify cleanup of temporary GitHub repo ${fullName}: the exact repo could not be read back to confirm HTTP 404; ${deleteSummary}; readback failed: ${readbackResult.output}.`,
  );
}

describe("checkout ship live GitHub mutation safety", () => {
  test("logged-in gh alone cannot enable live GitHub mutation", () => {
    const fullyAuthorizedGh: GitHubCliAuthStatus = {
      authenticated: true,
      canDeleteRepositories: true,
    };

    expect(shouldRunCheckoutShipLiveGitHubMutation(undefined, fullyAuthorizedGh)).toBe(false);
    expect(shouldRunCheckoutShipLiveGitHubMutation("0", fullyAuthorizedGh)).toBe(false);
    expect(shouldRunCheckoutShipLiveGitHubMutation("true", fullyAuthorizedGh)).toBe(false);
    expect(shouldRunCheckoutShipLiveGitHubMutation("1", fullyAuthorizedGh)).toBe(true);
  });

  test("cleanup failure is surfaced when the exact test repo remains readable", () => {
    const calls: string[][] = [];
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      calls.push(args);
      return args[0] === "repo"
        ? { succeeded: false, output: "HTTP 403: delete_repo scope required" }
        : { succeeded: true, output: '{"full_name":"octocat/checkout-ship-test"}' };
    };

    expect(() => deleteRepoAndVerifyAbsent("octocat/checkout-ship-test", runGitHubCommand)).toThrow(
      "Failed to clean up temporary GitHub repo octocat/checkout-ship-test: the exact repo remains readable",
    );
    expect(calls).toEqual([
      ["repo", "delete", "octocat/checkout-ship-test", "--yes"],
      ["api", "repos/octocat/checkout-ship-test"],
    ]);
  });

  test("cleanup readback failure is surfaced instead of being treated as deletion proof", () => {
    const runGitHubCommand: GitHubCliCommandRunner = (args) =>
      args[0] === "repo"
        ? { succeeded: true, output: "" }
        : { succeeded: false, output: "network unavailable" };

    expect(() => deleteRepoAndVerifyAbsent("octocat/checkout-ship-test", runGitHubCommand)).toThrow(
      "Failed to verify cleanup of temporary GitHub repo octocat/checkout-ship-test: the exact repo could not be read back to confirm HTTP 404",
    );
  });
});

describe("daemon checkout ship loop", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  testWithExplicitLiveGitHubOptIn(
    "runs the full checkout ship loop via checkout RPCs",
    async () => {
      assertCheckoutShipLiveGitHubMutationEnabled();

      const repoDir = tmpCwd("checkout-ship-");
      let repoFullName: string | null = null;
      let agentId: string | null = null;
      let testError: unknown;
      let repoCleanupError: unknown;

      try {
        initGitRepo(repoDir);

        const owner = getGhLogin();
        const repoName = createTempGithubRepoName("checkout-ship");
        repoFullName = `${owner}/${repoName}`;
        createPrivateRepo(repoName);

        const token = encodeURIComponent(getGhToken());
        execSync(
          `git remote add origin https://x-access-token:${token}@github.com/${repoFullName}.git`,
          {
            cwd: repoDir,
            stdio: "pipe",
          },
        );
        execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });

        const worktree = await createLegacyWorktreeForTest({
          branchName: "ship-loop",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "ship-loop",
          paseoHome: ctx.daemon.paseoHome,
        });

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd: worktree.worktreePath,
          title: "Checkout Ship Loop",
        });
        agentId = agent.id;

        const status = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        expect(status.isGit).toBe(true);
        expect(status.isPaseoOwnedWorktree).toBe(true);
        expect(realpathSync(status.repoRoot)).toBe(realpathSync(worktree.worktreePath));
        if (status.isGit) {
          expect(status.baseRef).toBe("main");
        }

        execSync("git branch -m ship-loop-ready", {
          cwd: worktree.worktreePath,
          stdio: "pipe",
        });

        const updatedStatus = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        expect(updatedStatus.currentBranch).toBe("ship-loop-ready");

        const readmePath = path.join(worktree.worktreePath, "README.md");
        writeFileSync(readmePath, "init\nship loop update\n");

        const diffUncommitted = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "uncommitted",
        });
        expect(diffUncommitted.error).toBeNull();
        expect(diffUncommitted.files.length).toBeGreaterThan(0);

        const timelineBeforeCommit = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const commitResult = await ctx.client.checkoutCommit(worktree.worktreePath, {
          addAll: true,
        });
        expect(commitResult.error).toBeNull();
        expect(commitResult.success).toBe(true);
        const timelineAfterCommit = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterCommit).toBe(timelineBeforeCommit);

        const diffAfterCommit = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "uncommitted",
        });
        expect(diffAfterCommit.files.length).toBe(0);

        const baseDiff = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "base",
          baseRef: "main",
        });
        expect(baseDiff.files.length).toBeGreaterThan(0);

        const timelineBeforePr = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const prCreate = await ctx.client.checkoutPrCreate(worktree.worktreePath, {
          baseRef: "main",
        });
        expect(prCreate.error).toBeNull();
        expect(prCreate.url).toContain(repoName);
        const timelineAfterPr = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterPr).toBe(timelineBeforePr);

        const prStatus = await ctx.client.checkoutPrStatus(worktree.worktreePath);
        expect(prStatus.error).toBeNull();
        expect(prStatus.githubFeaturesEnabled).toBe(true);

        const mergeResult = await ctx.client.checkoutMerge(worktree.worktreePath, {
          baseRef: "main",
          strategy: "merge",
          requireCleanTarget: true,
        });
        expect(mergeResult.error).toBeNull();
        expect(mergeResult.success).toBe(true);

        const statusAfterMerge = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        expect(statusAfterMerge.isGit).toBe(true);
        if (statusAfterMerge.isGit) {
          expect(statusAfterMerge.baseRef).toBe("main");
          expect(statusAfterMerge.aheadBehind?.ahead ?? 0).toBe(0);
        }

        const baseDiffAfterMerge = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "base",
          baseRef: "main",
        });
        expect(baseDiffAfterMerge.files.length).toBe(0);

        const worktreeList = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        expect(worktreeList.error).toBeNull();
        expect(
          worktreeList.worktrees.some(
            (entry) =>
              entry.worktreePath === worktree.worktreePath &&
              entry.branchName === "ship-loop-ready",
          ),
        ).toBe(true);

        const archiveResult = await ctx.client.archivePaseoWorktree({
          worktreePath: worktree.worktreePath,
        });
        expect(archiveResult.error).toBeNull();
        expect(archiveResult.success).toBe(true);

        // Archiving removes the agent from the active list but leaves the
        // worktree on disk — disk deletion is a separate, explicit step.
        const worktreeListAfter = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        expect(
          worktreeListAfter.worktrees.some((entry) => entry.worktreePath === worktree.worktreePath),
        ).toBe(true);
        expect(existsSync(worktree.worktreePath)).toBe(true);

        const remainingAgents = await ctx.client.fetchAgents();
        expect(remainingAgents.entries.some((entry) => entry.agent.id === agent.id)).toBe(false);
      } catch (error) {
        testError = error;
      } finally {
        if (agentId) {
          await ctx.client.deleteAgent(agentId).catch(() => undefined);
        }
        try {
          deleteRepoAndVerifyAbsent(repoFullName);
        } catch (error) {
          repoCleanupError = error;
        }
        rmSync(repoDir, { recursive: true, force: true });
      }

      if (testError && repoCleanupError) {
        throw new AggregateError(
          [testError, repoCleanupError],
          "Checkout ship live GitHub test failed and its temporary repository cleanup also failed",
        );
      }
      if (repoCleanupError) {
        throw repoCleanupError;
      }
      if (testError) {
        throw testError;
      }
    },
    180000,
  );

  test("merge-from-base and push RPCs work with a local origin remote", async () => {
    const repoDir = tmpCwd("checkout-merge-from-base-");
    let agentId: string | null = null;

    try {
      initGitRepo(repoDir);

      const remoteDir = path.join(repoDir, "remote.git");
      execSync(`git init --bare -b main ${remoteDir}`, { stdio: "pipe" });
      execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir, stdio: "pipe" });
      execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });

      const worktree = await createLegacyWorktreeForTest({
        branchName: "merge-from-base",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "merge-from-base",
        paseoHome: ctx.daemon.paseoHome,
      });

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd: worktree.worktreePath,
        title: "Merge From Base Test",
      });
      agentId = agent.id;

      const status = await ctx.client.getCheckoutStatus(worktree.worktreePath);
      expect(status.isGit).toBe(true);
      if (status.isGit) {
        expect(status.hasRemote).toBe(true);
        expect(status.baseRef).toBe("main");
      }

      // Advance local main, but leave the agent branch behind it.
      execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(path.join(repoDir, "base.txt"), "base update\n");
      execSync("git add base.txt", { cwd: repoDir, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'base update'", {
        cwd: repoDir,
        stdio: "pipe",
      });
      const baseCommit = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim();

      // Add a commit on the agent branch.
      writeFileSync(path.join(worktree.worktreePath, "feature.txt"), "feature\n");
      const commitResult = await ctx.client.checkoutCommit(worktree.worktreePath, {
        message: "feature commit",
        addAll: true,
      });
      expect(commitResult.error).toBeNull();
      expect(commitResult.success).toBe(true);

      const mergeFromBase = await ctx.client.checkoutMergeFromBase(worktree.worktreePath, {
        baseRef: "main",
        requireCleanTarget: true,
      });
      expect(mergeFromBase.error).toBeNull();
      expect(mergeFromBase.success).toBe(true);

      // Verify the agent branch now contains the base commit.
      execSync(`git merge-base --is-ancestor ${baseCommit} HEAD`, {
        cwd: worktree.worktreePath,
        stdio: "pipe",
      });

      const pushResult = await ctx.client.checkoutPush(worktree.worktreePath);
      expect(pushResult.error).toBeNull();
      expect(pushResult.success).toBe(true);
    } finally {
      if (agentId) {
        await ctx.client.deleteAgent(agentId).catch(() => undefined);
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 90000);

  test("checkout RPCs return NOT_GIT_REPO for non-git directories", async () => {
    const cwd = tmpCwd("checkout-ship-non-git-");
    let agentId: string | null = null;

    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Checkout Non-Git",
      });
      agentId = agent.id;

      const status = await ctx.client.getCheckoutStatus(cwd);
      expect(status.isGit).toBe(false);

      const diff = await ctx.client.getCheckoutDiff(cwd, {
        mode: "uncommitted",
      });
      expect(diff.error?.code).toBe("NOT_GIT_REPO");

      const commit = await ctx.client.checkoutCommit(cwd, {
        message: "Should fail",
        addAll: true,
      });
      expect(commit.error?.code).toBe("NOT_GIT_REPO");
    } finally {
      if (agentId) {
        await ctx.client.deleteAgent(agentId).catch(() => undefined);
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
});

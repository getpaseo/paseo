import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { z } from "zod";

import {
  createDaemonTestContext,
  createTempGithubRepoName,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createWorktree as createWorktreePrimitive } from "../../utils/worktree.js";
import type { PullRequestMergeable } from "../../shared/messages.js";

const GhPrViewSchema = z.object({
  state: z.string(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});

type GhPrView = z.infer<typeof GhPrViewSchema>;

const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function hasGitHubCliAuth(): boolean {
  try {
    execSync("gh auth status -h github.com", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasGitHubCliDeleteRepoScope(): boolean {
  try {
    const status = execSync("gh auth status -h github.com 2>&1", { stdio: "pipe" }).toString();
    const scopesLine = status.split(/\r?\n/).find((line) => /token[- ]scopes?:/i.test(line));
    const hasDeleteRepoScope = scopesLine?.includes("delete_repo") ?? false;

    if (!hasDeleteRepoScope) {
      console.warn(
        "Skipping checkout PR merge e2e: gh auth token is missing the delete_repo scope required to clean up temporary GitHub repos.",
      );
    }

    return hasDeleteRepoScope;
  } catch {
    return false;
  }
}

const hasRequiredGitHubCliAuth = hasGitHubCliAuth() && hasGitHubCliDeleteRepoScope();
const testWithGitHubCliAuth = hasRequiredGitHubCliAuth ? test : test.skip;

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
    const commandError = error as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const output = [commandError.stderr, commandError.stdout]
      .map((buffer) => buffer?.toString().trim())
      .filter(Boolean)
      .join("\n");

    return output || commandError.message || String(error);
  }

  return String(error);
}

function deleteRepoOrThrow(fullName: string | null): void {
  if (!fullName) {
    return;
  }

  try {
    execSync(`gh repo delete ${fullName} --yes`, { stdio: "pipe" });
  } catch (repoDeleteError) {
    try {
      execSync(`gh api -X DELETE repos/${fullName}`, { stdio: "pipe" });
    } catch (apiDeleteError) {
      throw new Error(
        `Failed to delete temporary GitHub repo ${fullName}. Clean it up manually. ` +
          `gh repo delete failed: ${formatCommandError(repoDeleteError)}. ` +
          `gh api DELETE failed: ${formatCommandError(apiDeleteError)}`,
        { cause: apiDeleteError },
      );
    }
  }
}

function readGhPrView(prNumber: number, repoFullName: string): GhPrView {
  return GhPrViewSchema.parse(
    JSON.parse(
      execSync(`gh pr view ${prNumber} -R ${repoFullName} --json state,mergedAt,mergeCommit`, {
        stdio: "pipe",
      }).toString(),
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollForMergeable(
  ctx: DaemonTestContext,
  worktreePath: string,
): Promise<number | undefined> {
  const deadline = Date.now() + 30000;
  let lastMergeable: PullRequestMergeable = "UNKNOWN";

  while (Date.now() < deadline) {
    const prStatus = await ctx.client.checkoutPrStatus(worktreePath);
    expect(prStatus.error).toBeNull();
    expect(prStatus.githubFeaturesEnabled).toBe(true);
    expect(prStatus.status).not.toBeNull();

    if (prStatus.status?.mergeable === "MERGEABLE") {
      return prStatus.status.number;
    }

    lastMergeable = prStatus.status?.mergeable ?? "UNKNOWN";
    await sleep(1500);
  }

  throw new Error(`Timed out waiting for GitHub PR to become MERGEABLE; last=${lastMergeable}`);
}

function readFetchedFile(repoDir: string, filePath: string): string {
  return execSync(`git show FETCH_HEAD:${filePath}`, { cwd: repoDir }).toString();
}

describe("daemon checkout PR merge loop", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  testWithGitHubCliAuth(
    "squash-merges a GitHub PR via checkout RPCs",
    async () => {
      const repoDir = tmpCwd("checkout-pr-merge-");
      let repoFullName: string | null = null;
      let agentId: string | null = null;
      let worktreePath: string | null = null;

      let repoCleanupError: unknown;
      try {
        initGitRepo(repoDir);

        const owner = getGhLogin();
        const repoName = createTempGithubRepoName("checkout-pr-merge");
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

        const worktree = await createWorktreePrimitive({
          cwd: repoDir,
          worktreeSlug: "merge-pr-squash",
          source: {
            kind: "branch-off",
            baseBranch: "main",
            branchName: "merge-pr-squash",
          },
          runSetup: true,
          paseoHome: ctx.daemon.paseoHome,
        });
        worktreePath = worktree.worktreePath;

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd: worktree.worktreePath,
          title: "Checkout PR Merge",
        });
        agentId = agent.id;

        writeFileSync(path.join(worktree.worktreePath, "feature.txt"), "squash merge\n");

        const commitResult = await ctx.client.checkoutCommit(worktree.worktreePath, {
          message: "Add squash merge fixture",
          addAll: true,
        });
        expect(commitResult.error).toBeNull();
        expect(commitResult.success).toBe(true);

        const pushResult = await ctx.client.checkoutPush(worktree.worktreePath);
        expect(pushResult.error).toBeNull();
        expect(pushResult.success).toBe(true);

        const prCreate = await ctx.client.checkoutPrCreate(worktree.worktreePath, {
          title: "Add squash merge fixture",
          body: "Created by the checkout PR merge e2e test.",
          baseRef: "main",
        });
        expect(prCreate.error).toBeNull();
        expect(prCreate.url).toContain(repoName);
        expect(prCreate.number).not.toBeNull();

        if (prCreate.number === null) {
          throw new Error("checkoutPrCreate returned success without a PR number");
        }
        const prNumber = prCreate.number;

        const mergeablePrNumber = await pollForMergeable(ctx, worktree.worktreePath);
        expect(mergeablePrNumber).toBe(prNumber);

        const mergeResult = await ctx.client.checkoutPrMerge(worktree.worktreePath, {
          method: "squash",
        });
        expect(mergeResult.error).toBeNull();
        expect(mergeResult.success).toBe(true);

        const prView = readGhPrView(prNumber, repoFullName);
        expect(prView).toEqual({
          state: "MERGED",
          mergedAt: expect.any(String),
          mergeCommit: {
            oid: expect.any(String),
          },
        });

        execSync("git fetch origin main", {
          cwd: repoDir,
          stdio: "pipe",
        });
        execSync("git merge-base --is-ancestor main FETCH_HEAD", {
          cwd: repoDir,
          stdio: "pipe",
        });
        expect(readFetchedFile(repoDir, "feature.txt")).toBe("squash merge\n");

        const archiveResult = await ctx.client.archivePaseoWorktree({
          worktreePath: worktree.worktreePath,
        });
        expect(archiveResult.error).toBeNull();
        expect(archiveResult.success).toBe(true);
        expect(existsSync(worktree.worktreePath)).toBe(false);
        worktreePath = null;

        const remainingAgents = await ctx.client.fetchAgents();
        expect(remainingAgents.entries.some((entry) => entry.agent.id === agent.id)).toBe(false);
        agentId = null;
      } finally {
        if (worktreePath) {
          await ctx.client.archivePaseoWorktree({ worktreePath }).catch(() => undefined);
        }
        if (agentId) {
          await ctx.client.deleteAgent(agentId).catch(() => undefined);
        }
        try {
          deleteRepoOrThrow(repoFullName);
        } catch (error) {
          repoCleanupError = error;
        }
        rmSync(repoDir, { recursive: true, force: true });
      }
      if (repoCleanupError) {
        throw repoCleanupError;
      }
    },
    180000,
  );
});

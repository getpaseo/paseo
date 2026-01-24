import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execSync } from "child_process";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createWorktree } from "../../utils/worktree.js";

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

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

const testWithGitHubCliAuth = hasGitHubCliAuth() ? test : test.skip;

type McpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ structuredContent?: Record<string, unknown> } | Record<string, unknown>>;
  toolResult?: unknown;
  isError?: boolean;
};

type McpClient = {
  callTool: (input: { name: string; args?: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
};

function getStructuredContent(result: McpToolResult): Record<string, unknown> | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && "structuredContent" in content && content.structuredContent) {
    return content.structuredContent;
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

function getToolResultText(result: McpToolResult): string {
  const chunks: string[] = [];
  if (result.structuredContent) {
    chunks.push(JSON.stringify(result.structuredContent));
  }
  if (result.toolResult !== undefined) {
    chunks.push(JSON.stringify(result.toolResult));
  }
  for (const entry of result.content ?? []) {
    if (entry && typeof entry === "object") {
      if ("text" in entry && typeof (entry as { text?: unknown }).text === "string") {
        chunks.push(String((entry as { text?: unknown }).text));
      }
      if (
        "structuredContent" in entry &&
        (entry as { structuredContent?: unknown }).structuredContent
      ) {
        chunks.push(JSON.stringify((entry as { structuredContent?: unknown }).structuredContent));
      }
    }
  }
  return chunks.join(" ").trim();
}

async function createMcpClient(port: number, agentId: string): Promise<McpClient> {
  const url = new URL(`http://127.0.0.1:${port}/mcp/agents`);
  url.searchParams.set("callerAgentId", agentId);
  const transport = new StreamableHTTPClientTransport(url);
  return (await experimental_createMCPClient({ transport })) as McpClient;
}

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

function createTempRepoName(): string {
  const rand = Math.random().toString(16).slice(2, 8);
  return `paseo-checkout-ship-${Date.now()}-${rand}`;
}

function getGhLogin(): string {
  return execSync("gh api user --jq .login", { stdio: "pipe" })
    .toString()
    .trim();
}

function createPrivateRepo(repoName: string): void {
  execSync(`gh api -X POST user/repos -f name=${repoName} -f private=true`, {
    stdio: "pipe",
  });
}

function getGhToken(): string {
  return execSync("gh auth token", { stdio: "pipe" }).toString().trim();
}

function deleteRepoBestEffort(fullName: string | null): void {
  if (!fullName) {
    return;
  }
  try {
    execSync(`gh repo delete ${fullName} --yes`, { stdio: "pipe" });
  } catch {
    // best-effort cleanup
  }
}

describe("daemon checkout ship loop", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

	testWithGitHubCliAuth(
		"runs the full checkout ship loop via checkout RPCs",
		async () => {
      const repoDir = tmpCwd("checkout-ship-");
      let repoFullName: string | null = null;
      let mcpClient: McpClient | null = null;
      let agentId: string | null = null;

      try {
        initGitRepo(repoDir);

        const owner = getGhLogin();
        const repoName = createTempRepoName();
        repoFullName = `${owner}/${repoName}`;
        createPrivateRepo(repoName);

        const token = encodeURIComponent(getGhToken());
        execSync(
          `git remote add origin https://x-access-token:${token}@github.com/${repoFullName}.git`,
          {
            cwd: repoDir,
            stdio: "pipe",
          }
        );
        execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });

        const worktree = await createWorktree({
          branchName: "ship-loop",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "ship-loop",
          paseoHome: ctx.daemon.paseoHome,
        });

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd: worktree.worktreePath,
          title: "Checkout Ship Loop",
        });
        agentId = agent.id;

        const status = await ctx.client.getCheckoutStatus(agent.id);
        expect(status.isGit).toBe(true);
        expect(status.isPaseoOwnedWorktree).toBe(true);
        expect(status.repoRoot).toContain(repoDir);
        if (status.isGit) {
          expect(status.baseRef).toBe("main");
        }

        mcpClient = await createMcpClient(ctx.daemon.port, agent.id);
        const renameResult = (await mcpClient.callTool({
          name: "set_branch",
          args: { name: "ship-loop-ready" },
        })) as McpToolResult;
        const renamePayload = getStructuredContent(renameResult);
        expect(renamePayload?.success).toBe(true);

        const updatedStatus = await ctx.client.getCheckoutStatus(agent.id);
        expect(updatedStatus.currentBranch).toBe("ship-loop-ready");

        const readmePath = path.join(worktree.worktreePath, "README.md");
        writeFileSync(readmePath, "init\nship loop update\n");

        const diffUncommitted = await ctx.client.getCheckoutDiff(agent.id, {
          mode: "uncommitted",
        });
        expect(diffUncommitted.error).toBeNull();
        expect(diffUncommitted.files.length).toBeGreaterThan(0);

        const timelineBeforeCommit =
          ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const commitResult = await ctx.client.checkoutCommit(agent.id, {
          addAll: true,
        });
        expect(commitResult.error).toBeNull();
        expect(commitResult.success).toBe(true);
        const timelineAfterCommit =
          ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterCommit).toBe(timelineBeforeCommit);

        const diffAfterCommit = await ctx.client.getCheckoutDiff(agent.id, {
          mode: "uncommitted",
        });
        expect(diffAfterCommit.files.length).toBe(0);

        const baseDiff = await ctx.client.getCheckoutDiff(agent.id, {
          mode: "base",
          baseRef: "main",
        });
        expect(baseDiff.files.length).toBeGreaterThan(0);

        const timelineBeforePr =
          ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const prCreate = await ctx.client.checkoutPrCreate(agent.id, {
          baseRef: "main",
        });
        expect(prCreate.error).toBeNull();
        expect(prCreate.url).toContain(repoName);
        const timelineAfterPr =
          ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterPr).toBe(timelineBeforePr);

        const prStatus = await ctx.client.checkoutPrStatus(agent.id);
        expect(prStatus.error).toBeNull();
        expect(prStatus.status?.url).toContain(repoName);
        expect(prStatus.status?.state).toBeTruthy();

        const mergeResult = await ctx.client.checkoutMerge(agent.id, {
          baseRef: "main",
          strategy: "merge",
          requireCleanTarget: true,
        });
        expect(mergeResult.error).toBeNull();
        expect(mergeResult.success).toBe(true);

        const statusAfterMerge = await ctx.client.getCheckoutStatus(agent.id);
        expect(statusAfterMerge.isGit).toBe(true);
        if (statusAfterMerge.isGit) {
          expect(statusAfterMerge.baseRef).toBe("main");
          expect(statusAfterMerge.aheadBehind?.ahead ?? 0).toBe(0);
        }

        const baseDiffAfterMerge = await ctx.client.getCheckoutDiff(agent.id, {
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
              entry.branchName === "ship-loop-ready"
          )
        ).toBe(true);

        const archiveResult = await ctx.client.archivePaseoWorktree({
          worktreePath: worktree.worktreePath,
        });
        expect(archiveResult.error).toBeNull();
        expect(archiveResult.success).toBe(true);

        const worktreeListAfter = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        expect(
          worktreeListAfter.worktrees.some(
            (entry) => entry.worktreePath === worktree.worktreePath
          )
        ).toBe(false);
        expect(existsSync(worktree.worktreePath)).toBe(false);

        const remainingAgents = ctx.client.listAgents();
        expect(remainingAgents.some((entry) => entry.id === agent.id)).toBe(false);
      } finally {
        if (mcpClient) {
          await mcpClient.close().catch(() => undefined);
        }
        if (agentId) {
          await ctx.client.deleteAgent(agentId).catch(() => undefined);
        }
        deleteRepoBestEffort(repoFullName);
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
		180000
	);

	test(
		"merge-from-base and push RPCs work with a local origin remote",
		async () => {
			const repoDir = tmpCwd("checkout-merge-from-base-");
			let agentId: string | null = null;

			try {
				initGitRepo(repoDir);

				const remoteDir = path.join(repoDir, "remote.git");
				execSync(`git init --bare ${remoteDir}`, { stdio: "pipe" });
				execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir, stdio: "pipe" });
				execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });

				const worktree = await createWorktree({
					branchName: "merge-from-base",
					cwd: repoDir,
					baseBranch: "main",
					worktreeSlug: "merge-from-base",
					paseoHome: ctx.daemon.paseoHome,
				});

				const agent = await ctx.client.createAgent({
					provider: "codex",
					model: CODEX_TEST_MODEL,
					reasoningEffort: CODEX_TEST_REASONING_EFFORT,
					cwd: worktree.worktreePath,
					title: "Merge From Base Test",
				});
				agentId = agent.id;

				const status = await ctx.client.getCheckoutStatus(agent.id);
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
				const commitResult = await ctx.client.checkoutCommit(agent.id, {
					message: "feature commit",
					addAll: true,
				});
				expect(commitResult.error).toBeNull();
				expect(commitResult.success).toBe(true);

				const mergeFromBase = await ctx.client.checkoutMergeFromBase(agent.id, {
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

				const pushResult = await ctx.client.checkoutPush(agent.id);
				expect(pushResult.error).toBeNull();
				expect(pushResult.success).toBe(true);
			} finally {
				if (agentId) {
					await ctx.client.deleteAgent(agentId).catch(() => undefined);
				}
				rmSync(repoDir, { recursive: true, force: true });
			}
		},
		90000
	);

	test(
		"checkout RPCs return NOT_GIT_REPO for non-git directories",
		async () => {
			const cwd = tmpCwd("checkout-ship-non-git-");
      let agentId: string | null = null;

      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Checkout Non-Git",
        });
        agentId = agent.id;

        const status = await ctx.client.getCheckoutStatus(agent.id);
        expect(status.isGit).toBe(false);

        const diff = await ctx.client.getCheckoutDiff(agent.id, {
          mode: "uncommitted",
        });
        expect(diff.error?.code).toBe("NOT_GIT_REPO");

        const commit = await ctx.client.checkoutCommit(agent.id, {
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
    },
    60000
  );

  test(
    "set_branch is rejected outside Paseo-owned worktrees",
    async () => {
      const repoDir = tmpCwd("checkout-ship-non-paseo-");
      let agentId: string | null = null;
      let mcpClient: McpClient | null = null;

      try {
        initGitRepo(repoDir);

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd: repoDir,
          title: "Checkout Non-Paseo",
        });
        agentId = agent.id;

        mcpClient = await createMcpClient(ctx.daemon.port, agent.id);
        let errorMessage = "";
        try {
          const result = (await mcpClient.callTool({
            name: "set_branch",
            args: { name: "not-allowed" },
          })) as McpToolResult;
          errorMessage = getToolResultText(result);
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        expect(errorMessage).toMatch(/NOT_ALLOWED|Branch renames are only allowed/);
      } finally {
        if (mcpClient) {
          await mcpClient.close().catch(() => undefined);
        }
        if (agentId) {
          await ctx.client.deleteAgent(agentId).catch(() => undefined);
        }
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
    60000
  );
});

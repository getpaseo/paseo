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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms (${label})`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function findTimelineToolCall(
  messages: SessionOutboundMessage[],
  agentId: string,
  predicate: (item: AgentTimelineItem) => boolean
): AgentTimelineItem | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.type !== "agent_stream") {
      continue;
    }
    if (msg.payload.agentId !== agentId) {
      continue;
    }
    const event = msg.payload.event as any;
    if (event?.type !== "timeline") {
      continue;
    }
    const item = event.item as AgentTimelineItem;
    if (item?.type === "tool_call" && predicate(item)) {
      return item;
    }
  }
  return null;
}

async function waitForTimelineToolCall(
  ctx: DaemonTestContext,
  agentId: string,
  predicate: (item: AgentTimelineItem) => boolean,
  timeoutMs = 10000
): Promise<Extract<AgentTimelineItem, { type: "tool_call" }>> {
  const existing = findTimelineToolCall(
    ctx.client.getMessageQueue(),
    agentId,
    predicate
  );
  if (existing && existing.type === "tool_call") {
    return existing;
  }

  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timeout = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for timeline tool_call (${agentId})`));
    }, timeoutMs);

    unsub = ctx.client.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") {
        return;
      }
      if (message.payload.agentId !== agentId) {
        return;
      }
      const event = message.payload.event as any;
      if (event?.type !== "timeline") {
        return;
      }
      const item = event.item as AgentTimelineItem;
      if (item?.type !== "tool_call") {
        return;
      }
      if (!predicate(item)) {
        return;
      }
      clearTimeout(timeout);
      unsub();
      resolve(item);
    });
  });
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

  describe("worktree setup", () => {
    test(
      "runs paseo.json setup asynchronously and reports status via timeline tool_call",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init", { cwd: repoRoot, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", {
          cwd: repoRoot,
          stdio: "pipe",
        });
        execSync("git config user.name 'Test'", { cwd: repoRoot, stdio: "pipe" });

        writeFileSync(path.join(repoRoot, "file.txt"), "hello\n");
        execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'initial'", {
          cwd: repoRoot,
          stdio: "pipe",
        });
        execSync("git branch -M main", { cwd: repoRoot, stdio: "pipe" });

        const setupCommand =
          'while [ ! -f "$PASEO_ROOT_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"';
        writeFileSync(
          path.join(repoRoot, "paseo.json"),
          JSON.stringify({ worktree: { setup: [setupCommand] } })
        );
        execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'add paseo.json'", {
          cwd: repoRoot,
          stdio: "pipe",
        });

        const agent = await withTimeout(
          ctx.client.createAgent({
            provider: "codex",
            model: CODEX_TEST_MODEL,
            reasoningEffort: CODEX_TEST_REASONING_EFFORT,
            cwd: repoRoot,
            title: "Async Worktree Setup Test",
            git: {
              createWorktree: true,
              createNewBranch: true,
              baseBranch: "main",
              newBranchName: "async-setup-test",
              worktreeSlug: "async-setup-test",
            },
          }),
          2500,
          "createAgent should not block on setup"
        );

        expect(agent.cwd).toContain(path.join(".paseo", "worktrees"));
        expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(false);

        const started = await waitForTimelineToolCall(
          ctx,
          agent.id,
          (item) => item.name === "paseo_worktree_setup" && item.status === "running",
          10000
        );

        expect(started.callId).toBeTruthy();

        writeFileSync(path.join(repoRoot, "allow-setup"), "ok\n");

        const completed = await waitForTimelineToolCall(
          ctx,
          agent.id,
          (item) =>
            item.name === "paseo_worktree_setup" &&
            item.callId === started.callId &&
            item.status === "completed",
          20000
        );

        expect(completed.output).toBeTruthy();
        expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(true);

        await ctx.client.deleteAgent(agent.id);
        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
    );

    test(
      "reports failures via timeline tool_call without deleting the created worktree",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init", { cwd: repoRoot, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", {
          cwd: repoRoot,
          stdio: "pipe",
        });
        execSync("git config user.name 'Test'", { cwd: repoRoot, stdio: "pipe" });

        writeFileSync(path.join(repoRoot, "file.txt"), "hello\n");
        execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'initial'", {
          cwd: repoRoot,
          stdio: "pipe",
        });
        execSync("git branch -M main", { cwd: repoRoot, stdio: "pipe" });

        const setupCommand =
          'echo "started" > "$PASEO_WORKTREE_PATH/setup-start.txt"; sleep 0.1; echo "boom" 1>&2; exit 7';
        writeFileSync(
          path.join(repoRoot, "paseo.json"),
          JSON.stringify({ worktree: { setup: [setupCommand] } })
        );
        execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'add failing setup'", {
          cwd: repoRoot,
          stdio: "pipe",
        });

        const agent = await withTimeout(
          ctx.client.createAgent({
            provider: "codex",
            model: CODEX_TEST_MODEL,
            reasoningEffort: CODEX_TEST_REASONING_EFFORT,
            cwd: repoRoot,
            title: "Async Worktree Setup Failure Test",
            git: {
              createWorktree: true,
              createNewBranch: true,
              baseBranch: "main",
              newBranchName: "async-setup-failure-test",
              worktreeSlug: "async-setup-failure-test",
            },
          }),
          2500,
          "createAgent should not block on failing setup"
        );

        expect(agent.cwd).toContain(path.join(".paseo", "worktrees"));
        expect(existsSync(agent.cwd)).toBe(true);

        const started = await waitForTimelineToolCall(
          ctx,
          agent.id,
          (item) => item.name === "paseo_worktree_setup" && item.status === "running",
          10000
        );

        const failed = await waitForTimelineToolCall(
          ctx,
          agent.id,
          (item) =>
            item.name === "paseo_worktree_setup" &&
            item.callId === started.callId &&
            item.status === "failed",
          20000
        );

        expect(existsSync(path.join(agent.cwd, "setup-start.txt"))).toBe(true);

        const output = failed.output as any;
        const commands = output?.commands as any[] | undefined;
        expect(Array.isArray(commands)).toBe(true);
        expect(commands?.[0]?.exitCode).toBe(7);

        await ctx.client.deleteAgent(agent.id);
        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
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

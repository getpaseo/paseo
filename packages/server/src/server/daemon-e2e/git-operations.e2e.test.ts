import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";
import { deriveWorktreeProjectHash } from "../../utils/worktree.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

async function withTimeout<T>(
  options: { promise: Promise<T>; timeoutMs: number; label: string }
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out after ${options.timeoutMs}ms (${options.label})`));
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([options.promise, timeout]);
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
  messages: SessionOutboundMessage[],
  agentId: string,
  predicate: (item: AgentTimelineItem) => boolean,
  timeoutMs = 10000
): Promise<Extract<AgentTimelineItem, { type: "tool_call" }>> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const existing = findTimelineToolCall(messages, agentId, predicate);
    if (existing && existing.type === "tool_call") {
      return existing;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const recentToolCalls: Array<{ name: string; status?: string; callId?: string }> = [];
  for (let i = messages.length - 1; i >= 0 && recentToolCalls.length < 10; i -= 1) {
    const msg = messages[i];
    if (msg?.type !== "agent_stream") continue;
    if (msg.payload.agentId !== agentId) continue;
    const event = msg.payload.event as any;
    if (event?.type !== "timeline") continue;
    const item = event.item as AgentTimelineItem;
    if (item?.type !== "tool_call") continue;
    recentToolCalls.push({ name: item.name, status: item.status, callId: item.callId });
  }
  throw new Error(
    `Timed out waiting for timeline tool_call (${agentId}). Recent tool_calls: ${JSON.stringify(
      recentToolCalls
    )}`
  );
}

async function waitForPathExists(
  options: { targetPath: string; timeoutMs: number; label: string }
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for ${options.label}: ${options.targetPath}`
  );
}

async function waitForPathRemoved(
  options: { targetPath: string; timeoutMs: number; label: string }
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (!existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for removal of ${options.label}: ${options.targetPath}`
  );
}

async function withShell<T>(shell: string, run: () => Promise<T>): Promise<T> {
  const originalShell = process.env.SHELL;
  process.env.SHELL = shell;
  try {
    return await run();
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  }
}

interface WorktreeTerminalBootstrapEntry {
  name: string | null;
  command: string;
  status: "started" | "failed";
  terminalId: string | null;
  error: string | null;
}

function getWorktreeTerminalBootstrapEntries(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>
): WorktreeTerminalBootstrapEntry[] | null {
  const detail = item.detail;
  if (!detail || detail.type !== "unknown" || !detail.output) {
    return null;
  }
  const output = detail.output as Record<string, unknown>;
  const terminals = output.terminals;
  if (!Array.isArray(terminals)) {
    return null;
  }
  return terminals as WorktreeTerminalBootstrapEntry[];
}

// Use gpt-5.1-codex-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;
  let collector: MessageCollector;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    collector = createMessageCollector(ctx.client);
  });

  afterEach(async () => {
    collector.unsubscribe();
    await ctx.cleanup();
  }, 60000);

  describe("getCheckoutDiff", () => {
    test(
      "returns diff for modified file in git repo",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo
        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd, stdio: "pipe" });
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

        const result = await ctx.client.getCheckoutDiff(cwd, { mode: "uncommitted" });
        expect(result.error).toBeNull();
        expect(result.files.length).toBeGreaterThan(0);
        const file = result.files.find((entry) => entry.path === "test.txt");
        expect(file).toBeTruthy();
        expect(file?.hunks.length).toBeGreaterThan(0);
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
        execSync("git init -b main", { cwd, stdio: "pipe" });
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

        const result = await ctx.client.getCheckoutDiff(cwd, { mode: "uncommitted" });

        expect(result.error).toBeNull();
        expect(result.files).toEqual([]);

        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns error for non-git directory",
      async () => {
        const cwd = tmpCwd();
        // Don't initialize git - just a regular directory

        const result = await ctx.client.getCheckoutDiff(cwd, { mode: "uncommitted" });

        expect(result.files).toEqual([]);
        expect(result.error).toBeTruthy();
        expect(result.error?.code).toBe("NOT_GIT_REPO");

        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });


  describe("getCheckoutStatus", () => {
    test(
      "returns repo info for git repo with branch and dirty state",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo
        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd, stdio: "pipe" });
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
          provider: "codex", model: CODEX_TEST_MODEL, thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd,
          title: "Git Repo Info Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Get checkout status
        const result = await ctx.client.getCheckoutStatus(cwd);

        // Verify repo info returned without error
        expect(result.error).toBeNull();
        expect(result.isGit).toBe(true);
        // macOS symlinks /var to /private/var, so we check containment
        expect(result.repoRoot).toContain("daemon-e2e-");
        expect(result.currentBranch).toBeTruthy();
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
        execSync("git init -b main", { cwd, stdio: "pipe" });
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
          provider: "codex", model: CODEX_TEST_MODEL, thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd,
          title: "Git Repo Info Clean Test",
        });

        expect(agent.id).toBeTruthy();

        // Get checkout status
        const result = await ctx.client.getCheckoutStatus(cwd);

        expect(result.error).toBeNull();
        expect(result.isGit).toBe(true);
        expect(result.isDirty).toBe(false);
        expect(result.currentBranch).toBeTruthy();

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns isGit false for non-git directory",
      async () => {
        const cwd = tmpCwd();
        // Don't initialize git - just a regular directory

        // Create agent in a non-git directory
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd,
          title: "Git Repo Info Non-Git Test",
        });

        expect(agent.id).toBeTruthy();

        // Get checkout status - should return isGit: false
        const result = await ctx.client.getCheckoutStatus(cwd);

        expect(result.isGit).toBe(false);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });

  describe("worktree setup", () => {
    test(
      "runs junction.json setup asynchronously and reports status via timeline tool_call",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
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
          'while [ ! -f "$JUNCTION_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$JUNCTION_WORKTREE_PATH/setup-done.txt"';
        writeFileSync(
          path.join(repoRoot, "junction.json"),
          JSON.stringify({ worktree: { setup: [setupCommand] } })
        );
        execSync("git add junction.json", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'add junction.json'", {
          cwd: repoRoot,
          stdio: "pipe",
        });

        const agent = await withTimeout({
          promise: ctx.client.createAgent({
            provider: "codex",
            model: CODEX_TEST_MODEL,
            thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
          timeoutMs: 2500,
          label: "createAgent should not block on setup",
        });

        expect(agent.cwd).toContain(path.join(".junction", "worktrees"));
        expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(false);

        writeFileSync(path.join(agent.cwd, "allow-setup"), "ok\n");

        const completed = await waitForTimelineToolCall(
          collector.messages,
          agent.id,
          (item) => item.name === "junction_worktree_setup" && item.status === "completed",
          20000
        );

        expect(completed.callId).toBeTruthy();
        expect(completed.detail.type).toBe("worktree_setup");
        if (completed.detail.type === "worktree_setup") {
          expect(completed.detail.commands.length).toBeGreaterThan(0);
          expect(completed.detail.log.length).toBeGreaterThan(0);
        }
        expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(true);

        await ctx.client.deleteAgent(agent.id);
        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
    );

    test(
      "bootstraps configured worktree terminals after setup succeeds",
      async () => {
        await withShell("/bin/sh", async () => {
          const repoRoot = tmpCwd();

          const { execSync } = await import("child_process");
          execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
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
            'while [ ! -f "$JUNCTION_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$JUNCTION_WORKTREE_PATH/setup-done.txt"; echo "$JUNCTION_WORKTREE_PORT" > "$JUNCTION_WORKTREE_PATH/setup-port.txt"';
          writeFileSync(
            path.join(repoRoot, "junction.json"),
            JSON.stringify({
              worktree: {
                setup: [setupCommand],
                terminals: [
                  {
                    name: "Dev Server",
                    command: "tail -f /dev/null",
                  },
                  {
                    command: "tail -f /dev/null",
                  },
                ],
              },
            })
          );
          execSync("git add junction.json", { cwd: repoRoot, stdio: "pipe" });
          execSync("git -c commit.gpgsign=false commit -m 'add setup and terminals'", {
            cwd: repoRoot,
            stdio: "pipe",
          });

          const agent = await withTimeout({
            promise: ctx.client.createAgent({
              provider: "codex",
              model: CODEX_TEST_MODEL,
              thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
              cwd: repoRoot,
              title: "Async Worktree Setup + Terminals Test",
              git: {
                createWorktree: true,
                createNewBranch: true,
                baseBranch: "main",
                newBranchName: "async-setup-terminals-test",
                worktreeSlug: "async-setup-terminals-test",
              },
            }),
            timeoutMs: 2500,
            label: "createAgent should not block on setup",
          });

          expect(agent.cwd).toContain(path.join(".junction", "worktrees"));
          expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(false);
          expect(existsSync(path.join(agent.cwd, "dev-terminal.txt"))).toBe(false);
          expect(existsSync(path.join(agent.cwd, "lint-terminal.txt"))).toBe(false);

          writeFileSync(path.join(agent.cwd, "allow-setup"), "ok\n");

          await waitForTimelineToolCall(
            collector.messages,
            agent.id,
            (item) => item.name === "junction_worktree_setup" && item.status === "completed",
            20000
          );
          const terminalsBootstrapToolCall = await waitForTimelineToolCall(
            collector.messages,
            agent.id,
            (item) => item.name === "junction_worktree_terminals" && item.status === "completed",
            30000
          );
          const bootstrappedTerminals = getWorktreeTerminalBootstrapEntries(
            terminalsBootstrapToolCall
          );
          expect(bootstrappedTerminals).toBeTruthy();
          expect(bootstrappedTerminals?.length ?? 0).toBeGreaterThanOrEqual(2);
          const failedBootstraps =
            bootstrappedTerminals?.filter((terminal) => terminal.status === "failed") ?? [];
          expect(failedBootstraps).toEqual([]);

          const list = await ctx.client.listTerminals(agent.cwd);
          expect(list.error).toBeUndefined();
          expect(list.terminals.some((terminal) => terminal.name === "Dev Server")).toBe(true);
          expect(list.terminals.length).toBeGreaterThanOrEqual(2);
          await waitForPathExists({
            targetPath: path.join(agent.cwd, "setup-port.txt"),
            timeoutMs: 30000,
            label: "setup runtime port marker",
          });

          const setupPort = readFileSync(path.join(agent.cwd, "setup-port.txt"), "utf8").trim();
          expect(setupPort.length).toBeGreaterThan(0);

          const createdTerminal = await ctx.client.createTerminal(agent.cwd, "Manual Port Check");
          expect(createdTerminal.error).toBeNull();
          expect(createdTerminal.terminal).toBeTruthy();
          const manualTerminalId = createdTerminal.terminal?.id;
          expect(manualTerminalId).toBeTruthy();
          if (!manualTerminalId) {
            throw new Error("Expected manual terminal id");
          }
          ctx.client.sendTerminalInput(manualTerminalId, {
            type: "input",
            data: 'echo "$JUNCTION_WORKTREE_PORT" > "$JUNCTION_WORKTREE_PATH/manual-terminal-port.txt"\r',
          });
          await waitForPathExists({
            targetPath: path.join(agent.cwd, "manual-terminal-port.txt"),
            timeoutMs: 30000,
            label: "manual terminal runtime port marker",
          });
          const manualTerminalPort = readFileSync(
            path.join(agent.cwd, "manual-terminal-port.txt"),
            "utf8"
          ).trim();
          expect(manualTerminalPort).toBe(setupPort);

          await ctx.client.deleteAgent(agent.id);
          rmSync(repoRoot, { recursive: true, force: true });
        });
      },
      60000
    );

    test(
      "reports failures via timeline tool_call without deleting the created worktree",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
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
          'echo "started" > "$JUNCTION_WORKTREE_PATH/setup-start.txt"; sleep 0.1; echo "boom" 1>&2; exit 7';
        writeFileSync(
          path.join(repoRoot, "junction.json"),
          JSON.stringify({
            worktree: {
              setup: [setupCommand],
              terminals: [
                {
                  name: "Should Not Start",
                  command: 'echo "should-not-run" > should-not-run.txt; tail -f /dev/null',
                },
              ],
            },
          })
        );
        execSync("git add junction.json", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'add failing setup'", {
          cwd: repoRoot,
          stdio: "pipe",
        });

        const agent = await withTimeout({
          promise: ctx.client.createAgent({
            provider: "codex",
            model: CODEX_TEST_MODEL,
            thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
          timeoutMs: 2500,
          label: "createAgent should not block on failing setup",
        });

        expect(agent.cwd).toContain(path.join(".junction", "worktrees"));
        expect(existsSync(agent.cwd)).toBe(true);

        const started = await waitForTimelineToolCall(
          collector.messages,
          agent.id,
          (item) => item.name === "junction_worktree_setup" && item.status === "running",
          10000
        );

        const failed = await waitForTimelineToolCall(
          collector.messages,
          agent.id,
          (item) =>
            item.name === "junction_worktree_setup" &&
            item.callId === started.callId &&
            item.status === "failed",
          20000
        );

        expect(existsSync(path.join(agent.cwd, "setup-start.txt"))).toBe(true);
        expect(existsSync(path.join(agent.cwd, "should-not-run.txt"))).toBe(false);

        expect(failed.detail.type).toBe("worktree_setup");
        if (failed.detail.type === "worktree_setup") {
          expect(Array.isArray(failed.detail.commands)).toBe(true);
          expect(failed.detail.commands[0]?.exitCode).toBe(7);
          expect(failed.detail.log).toContain("Exit 7");
        }

        await ctx.client.deleteAgent(agent.id);
        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
    );
  });

  describe("createAgent with worktree", () => {
    test(
      "creates agent in ~/.junction/worktrees/{hash} when worktree is requested",
      async () => {
        const cwd = tmpCwd();
        const projectHash = await deriveWorktreeProjectHash(cwd);

        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd, stdio: "pipe" });
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
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd,
          title: "Worktree Agent Test",
          git: {
            createWorktree: true,
            createNewBranch: true,
            newBranchName: "worktree-test",
            worktreeSlug: "worktree-test",
            baseBranch: "main",
          },
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");
        expect(realpathSync(agent.cwd)).toBe(
          realpathSync(
            path.join(
              ctx.daemon.junctionHome,
              "worktrees",
              projectHash,
              "worktree-test"
            )
          )
        );
        expect(existsSync(agent.cwd)).toBe(true);

        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );
  });

  describe("archiveJunctionWorktree", () => {
    test(
      "archives worktree by running destroy commands and shutting down worktree terminals",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
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

        const destroyMarkerPath = path.join(repoRoot, "destroy-marker.txt");
        writeFileSync(
          path.join(repoRoot, "junction.json"),
          JSON.stringify({
            worktree: {
              terminals: [
                {
                  name: "Dev Server",
                  command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
                },
              ],
              destroy: [
                `echo "$JUNCTION_WORKTREE_PATH" > "${destroyMarkerPath}"`,
              ],
            },
          })
        );
        execSync("git add junction.json", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'add worktree terminal + destroy'", {
          cwd: repoRoot,
          stdio: "pipe",
        });

        const agent = await withTimeout({
          promise: ctx.client.createAgent({
            provider: "codex",
            model: CODEX_TEST_MODEL,
            thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
            cwd: repoRoot,
            title: "Worktree Archive Cleanup Test",
            git: {
              createWorktree: true,
              createNewBranch: true,
              baseBranch: "main",
              newBranchName: "archive-cleanup-test",
              worktreeSlug: "archive-cleanup-test",
            },
          }),
          timeoutMs: 2500,
          label: "createAgent should not block on setup",
        });

        await waitForPathExists({
          targetPath: path.join(agent.cwd, "dev-terminal.txt"),
          timeoutMs: 15000,
          label: "worktree terminal marker",
        });

        const beforeArchiveDirectories = ctx.daemon.daemon.terminalManager.listDirectories();
        expect(beforeArchiveDirectories).toContain(agent.cwd);

        const archive = await ctx.client.archiveJunctionWorktree({
          worktreePath: agent.cwd,
        });
        expect(archive.error).toBeNull();
        expect(archive.success).toBe(true);
        expect(archive.removedAgents).toContain(agent.id);

        expect(existsSync(agent.cwd)).toBe(false);
        expect(existsSync(destroyMarkerPath)).toBe(true);
        expect(readFileSync(destroyMarkerPath, "utf8").trim()).toBe(agent.cwd);

        const afterArchiveDirectories = ctx.daemon.daemon.terminalManager.listDirectories();
        expect(afterArchiveDirectories).not.toContain(agent.cwd);

        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
    );

    test(
      "archives the worktree when the last agent in it is archived",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
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

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd: repoRoot,
          title: "Archive Last Agent Cleanup Test",
          git: {
            createWorktree: true,
            createNewBranch: true,
            baseBranch: "main",
            newBranchName: "archive-last-agent",
            worktreeSlug: "archive-last-agent",
          },
        });

        expect(existsSync(agent.cwd)).toBe(true);

        const result = await ctx.client.archiveAgent(agent.id);
        expect(result.archivedAt).toBeTruthy();

        await waitForPathRemoved({
          targetPath: agent.cwd,
          timeoutMs: 10000,
          label: "archived worktree",
        });

        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
    );

    test(
      "does not archive the worktree until all agents in it are archived",
      async () => {
        const repoRoot = tmpCwd();

        const { execSync } = await import("child_process");
        execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
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

        const firstAgent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd: repoRoot,
          title: "Archive Multi-Agent Test 1",
          git: {
            createWorktree: true,
            createNewBranch: true,
            baseBranch: "main",
            newBranchName: "archive-multi-agent",
            worktreeSlug: "archive-multi-agent",
          },
        });

        const secondAgent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd: firstAgent.cwd,
          title: "Archive Multi-Agent Test 2",
        });

        expect(existsSync(firstAgent.cwd)).toBe(true);

        await ctx.client.archiveAgent(firstAgent.id);

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(existsSync(firstAgent.cwd)).toBe(true);

        await ctx.client.archiveAgent(secondAgent.id);

        await waitForPathRemoved({
          targetPath: firstAgent.cwd,
          timeoutMs: 10000,
          label: "worktree after final agent archive",
        });

        rmSync(repoRoot, { recursive: true, force: true });
      },
      60000
    );
  });


});

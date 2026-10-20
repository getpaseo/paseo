import { test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  realpathSync,
  mkdirSync,
} from "fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { deriveWorktreeProjectHash } from "../../utils/worktree.js";
import { isPlatform } from "../../test-utils/platform.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

async function waitForPathExists(options: {
  targetPath: string;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  await waitForCondition({
    timeoutMs: options.timeoutMs,
    label: `${options.label}: ${options.targetPath}`,
    predicate: () => existsSync(options.targetPath),
  });
}

async function waitForCondition(options: {
  timeoutMs: number;
  label: string;
  predicate: () => boolean | Promise<boolean>;
}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (await options.predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}`);
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

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

let ctx: DaemonTestContext;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
}, 60000);

interface GitCommandOptions {
  cwd: string;
  args: string[];
}

async function mergeFeatureIntoBaseWorktree(baseName: string): Promise<void> {
  const directory = realpathSync(tmpCwd());
  const base = path.join(directory, baseName);
  const feature = path.join(directory, "feature");
  function git({ cwd, args }: GitCommandOptions): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  }
  try {
    mkdirSync(base);
    git({ cwd: base, args: ["init", "-b", "main"] });
    git({ cwd: base, args: ["config", "user.name", "Paseo Test"] });
    git({ cwd: base, args: ["config", "user.email", "test@paseo.local"] });
    git({ cwd: base, args: ["config", "commit.gpgsign", "false"] });
    git({ cwd: base, args: ["config", "core.autocrlf", "false"] });
    git({ cwd: base, args: ["commit", "--allow-empty", "-m", "base"] });
    git({ cwd: base, args: ["worktree", "add", "-b", "feature", feature] });
    writeFileSync(path.join(feature, "feature.txt"), "feature payload\n");
    git({ cwd: feature, args: ["add", "feature.txt"] });
    git({ cwd: feature, args: ["commit", "-m", "feature"] });
    const featureCommit = git({ cwd: feature, args: ["rev-parse", "HEAD"] }).trim();

    const merged = await ctx.client.checkoutMerge(feature, { baseRef: "main" });
    expect(merged).toMatchObject({ success: true, error: null });
    expect(git({ cwd: base, args: ["rev-parse", "HEAD"] }).trim()).toBe(featureCommit);
    expect(readFileSync(path.join(base, "feature.txt"), "utf8")).toBe("feature payload\n");
    expect(git({ cwd: feature, args: ["symbolic-ref", "--short", "HEAD"] }).trim()).toBe("feature");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.skipIf(isPlatform("win32")).each(["base\ncheckout", "base "])(
  "merges into a base worktree whose path preserves %j",
  mergeFeatureIntoBaseWorktree,
);

test.each(["base checkout", "中文 checkout"])(
  "merges into a base worktree named %j",
  mergeFeatureIntoBaseWorktree,
);

test("merges into a local base branch without another worktree", async () => {
  const cwd = realpathSync(tmpCwd());
  function git(args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  }
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Paseo Test"]);
    git(["config", "user.email", "test@paseo.local"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-m", "base"]);
    git(["checkout", "-b", "feature"]);
    writeFileSync(path.join(cwd, "feature.txt"), "feature payload\n");
    git(["add", "feature.txt"]);
    git(["commit", "-m", "feature"]);
    const featureCommit = git(["rev-parse", "HEAD"]).trim();

    const merged = await ctx.client.checkoutMerge(cwd, { baseRef: "main" });
    expect(merged).toMatchObject({ success: true, error: null });
    expect(git(["rev-parse", "main"]).trim()).toBe(featureCommit);
    expect(git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe("feature");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("returns diff for modified file in git repo", async () => {
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
}, 60000); // 1 minute timeout

test("returns empty diff when no changes", async () => {
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
}, 60000); // 1 minute timeout

test("returns error for non-git directory", async () => {
  const cwd = tmpCwd();
  // Don't initialize git - just a regular directory

  const result = await ctx.client.getCheckoutDiff(cwd, { mode: "uncommitted" });

  expect(result.files).toEqual([]);
  expect(result.error).toBeTruthy();
  expect(result.error?.code).toBe("NOT_GIT_REPO");

  rmSync(cwd, { recursive: true, force: true });
}, 60000); // 1 minute timeout

// POSIX-only: asserts repo-root containment across macOS /var symlink normalization.
test.skipIf(isPlatform("win32"))(
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
      provider: "codex",
      model: CODEX_TEST_MODEL,
      thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
  60000,
); // 1 minute timeout

test("returns clean state when no uncommitted changes", async () => {
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
    provider: "codex",
    model: CODEX_TEST_MODEL,
    thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
}, 60000); // 1 minute timeout

test("returns isGit false for non-git directory", async () => {
  const cwd = tmpCwd();
  // Don't initialize git - just a regular directory

  // Create agent in a non-git directory
  const agent = await ctx.client.createAgent({
    provider: "codex",
    model: CODEX_TEST_MODEL,
    thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
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
}, 60000); // 1 minute timeout

test("runs paseo.json setup asynchronously and reports workspace status", async () => {
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
    'while [ ! -f "$PASEO_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"';
  writeFileSync(
    path.join(repoRoot, "paseo.json"),
    JSON.stringify({ worktree: { setup: [setupCommand] } }),
  );
  execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'add paseo.json'", {
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
      worktree: { mode: "branch-off", newBranch: "async-setup-test", base: "main" },
    }),
    timeoutMs: 2500,
    label: "createAgent should not block on setup",
  });

  expect(agent.cwd).toContain(path.join(".paseo", "worktrees"));
  expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(false);

  writeFileSync(path.join(agent.cwd, "allow-setup"), "ok\n");

  const completed = await waitForWorkspaceSetup(agent.workspaceId!, "completed");
  expect(completed.detail.log).toBe("");
  expect(completed.detail.commands).toEqual([
    expect.objectContaining({ status: "completed", exitCode: 0 }),
  ]);
  expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(true);

  await ctx.client.deleteAgent(agent.id);
  rmSync(repoRoot, { recursive: true, force: true });
}, 60000);

test("bootstraps configured worktree terminals after setup succeeds", async () => {
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
      'while [ ! -f "$PASEO_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"; echo "$PASEO_WORKTREE_PORT" > "$PASEO_WORKTREE_PATH/setup-port.txt"';
    writeFileSync(
      path.join(repoRoot, "paseo.json"),
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
      }),
    );
    execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
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
        worktree: { mode: "branch-off", newBranch: "async-setup-terminals-test", base: "main" },
      }),
      timeoutMs: 2500,
      label: "createAgent should not block on setup",
    });

    expect(agent.cwd).toContain(path.join(".paseo", "worktrees"));
    expect(existsSync(path.join(agent.cwd, "setup-done.txt"))).toBe(false);
    expect(existsSync(path.join(agent.cwd, "dev-terminal.txt"))).toBe(false);
    expect(existsSync(path.join(agent.cwd, "lint-terminal.txt"))).toBe(false);

    writeFileSync(path.join(agent.cwd, "allow-setup"), "ok\n");

    await waitForWorkspaceSetup(agent.workspaceId!, "completed");
    await expect
      .poll(async () => (await ctx.client.listTerminals(agent.cwd)).terminals.length, {
        timeout: 30000,
      })
      .toBe(2);
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

    const openedWorktree = await ctx.client.openProject(agent.cwd);
    if (!openedWorktree.workspace) {
      throw new Error(openedWorktree.error ?? `Failed to open worktree workspace for ${agent.cwd}`);
    }
    const createdTerminal = await ctx.client.createTerminal(
      agent.cwd,
      "Manual Port Check",
      undefined,
      {
        workspaceId: openedWorktree.workspace.id,
      },
    );
    expect(createdTerminal.error).toBeNull();
    expect(createdTerminal.terminal).toBeTruthy();
    const manualTerminalId = createdTerminal.terminal?.id;
    expect(manualTerminalId).toBeTruthy();
    if (!manualTerminalId) {
      throw new Error("Expected manual terminal id");
    }
    ctx.client.sendTerminalInput(manualTerminalId, {
      type: "input",
      data: 'echo "$PASEO_WORKTREE_PORT" > "$PASEO_WORKTREE_PATH/manual-terminal-port.txt"\r',
    });
    await waitForPathExists({
      targetPath: path.join(agent.cwd, "manual-terminal-port.txt"),
      timeoutMs: 30000,
      label: "manual terminal runtime port marker",
    });
    const manualTerminalPort = readFileSync(
      path.join(agent.cwd, "manual-terminal-port.txt"),
      "utf8",
    ).trim();
    expect(manualTerminalPort).toBe(setupPort);

    await ctx.client.deleteAgent(agent.id);
    rmSync(repoRoot, { recursive: true, force: true });
  });
}, 60000);

test("reports workspace setup failures without deleting the created worktree", async () => {
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
    'echo "started" > "$PASEO_WORKTREE_PATH/setup-start.txt"; sleep 0.1; echo "boom" 1>&2; exit 7';
  writeFileSync(
    path.join(repoRoot, "paseo.json"),
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
    }),
  );
  execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
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
      worktree: { mode: "branch-off", newBranch: "async-setup-failure-test", base: "main" },
    }),
    timeoutMs: 2500,
    label: "createAgent should not block on failing setup",
  });

  expect(agent.cwd).toContain(path.join(".paseo", "worktrees"));
  expect(existsSync(agent.cwd)).toBe(true);

  const failed = await waitForWorkspaceSetup(agent.workspaceId!, "failed");
  expect(existsSync(path.join(agent.cwd, "setup-start.txt"))).toBe(true);
  expect(existsSync(path.join(agent.cwd, "should-not-run.txt"))).toBe(false);

  expect(failed.detail.type).toBe("worktree_setup");
  if (failed.detail.type === "worktree_setup") {
    expect(Array.isArray(failed.detail.commands)).toBe(true);
    expect(failed.detail.commands[0]?.exitCode).toBe(7);
    expect(failed.detail.log).toBe("");
    expect(failed.detail.commands[0]?.log).toContain("boom");
  }

  await ctx.client.deleteAgent(agent.id);
  rmSync(repoRoot, { recursive: true, force: true });
}, 60000);

test("creates agent in ~/.paseo/worktrees/{hash} when worktree is requested", async () => {
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
    worktree: { mode: "branch-off", newBranch: "worktree-test", base: "main" },
  });

  expect(agent.id).toBeTruthy();
  expect(agent.status).toBe("idle");
  expect(realpathSync(agent.cwd)).toBe(
    realpathSync(path.join(ctx.daemon.paseoHome, "worktrees", projectHash, "worktree-test")),
  );
  expect(existsSync(agent.cwd)).toBe(true);

  await ctx.client.deleteAgent(agent.id);
  rmSync(cwd, { recursive: true, force: true });
}, 60000);

test("archiving a worktree shuts down terminals and removes its final workspace backing", async () => {
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

  const teardownMarkerPath = path.join(repoRoot, "teardown-marker.txt");
  writeFileSync(
    path.join(repoRoot, "paseo.json"),
    JSON.stringify({
      worktree: {
        terminals: [
          {
            name: "Dev Server",
            command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
          },
        ],
        teardown: [`echo "$PASEO_WORKTREE_PATH" > "${teardownMarkerPath}"`],
      },
    }),
  );
  execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'add worktree terminal + teardown'", {
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
      worktree: { mode: "branch-off", newBranch: "archive-cleanup-test", base: "main" },
    }),
    timeoutMs: 2500,
    label: "createAgent should not block on setup",
  });

  await waitForCondition({
    timeoutMs: 30000,
    label: `worktree terminal bootstrap for ${agent.cwd}`,
    predicate: async () => {
      const directories = ctx.daemon.daemon.terminalManager.listDirectories();
      if (!directories.includes(agent.cwd)) {
        return false;
      }
      const terminals = await ctx.client.listTerminals(agent.cwd);
      return terminals.terminals.some((terminal) => terminal.name === "Dev Server");
    },
  });

  const beforeArchiveDirectories = ctx.daemon.daemon.terminalManager.listDirectories();
  expect(beforeArchiveDirectories).toContain(agent.cwd);

  const archive = await ctx.client.archivePaseoWorktree({
    worktreePath: agent.cwd,
  });
  expect(archive.error).toBeNull();
  expect(archive.success).toBe(true);
  expect(archive.removedAgents).toContain(agent.id);

  // The final workspace reference owns teardown and backing-worktree removal.
  expect(existsSync(agent.cwd)).toBe(false);
  expect(readFileSync(teardownMarkerPath, "utf8").trim()).toBe(agent.cwd);

  const afterArchiveDirectories = ctx.daemon.daemon.terminalManager.listDirectories();
  expect(afterArchiveDirectories).not.toContain(agent.cwd);

  rmSync(repoRoot, { recursive: true, force: true });
}, 60000);

async function waitForWorkspaceSetup(workspaceId: string, status: "completed" | "failed") {
  await expect
    .poll(async () => (await ctx.client.fetchWorkspaceSetupStatus(workspaceId)).snapshot?.status, {
      timeout: 20000,
    })
    .toBe(status);
  const snapshot = (await ctx.client.fetchWorkspaceSetupStatus(workspaceId)).snapshot;
  if (!snapshot) throw new Error("Expected workspace setup snapshot");
  return snapshot;
}

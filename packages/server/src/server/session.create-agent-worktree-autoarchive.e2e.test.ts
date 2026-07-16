import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import type { CreateAgentOptions } from "./test-utils/index.js";
import type { CreateAgentWorktreeTarget } from "./messages.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";

let ctx: DaemonTestContext;
const tempRoots: string[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createGitRepo(): string {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "create-agent-worktree-"));
  tempRoots.push(tempRoot);
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return repoDir;
}

function createGitRepoWithNestedDirectory(): string {
  const repoDir = createGitRepo();
  mkdirSync(path.join(repoDir, "packages", "app"), { recursive: true });
  writeFileSync(path.join(repoDir, "packages", "app", ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add nested app"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return repoDir;
}

async function expectAgentAbsentFromActiveList(agentId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const active = await ctx.client.fetchAgents();
        return active.entries.map((entry) => entry.agent.id).includes(agentId);
      },
      { timeout: 15000, interval: 100 },
    )
    .toBe(false);
}

async function expectAgentPresentInActiveList(agentId: string): Promise<void> {
  const active = await ctx.client.fetchAgents();
  expect(active.entries.map((entry) => entry.agent.id)).toContain(agentId);
}

async function expectActiveAgentListEmpty(): Promise<void> {
  const active = await ctx.client.fetchAgents();
  expect(active.entries).toEqual([]);
}

async function expectWorktreePresentInList(repoDir: string, worktreePath: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await ctx.client.getPaseoWorktreeList({ cwd: repoDir });
        return listed.worktrees.map((worktree) => worktree.worktreePath).includes(worktreePath);
      },
      { timeout: 5000, interval: 100 },
    )
    .toBe(true);
}

async function expectWorktreeListEmpty(repoDir: string): Promise<void> {
  const listed = await ctx.client.getPaseoWorktreeList({ cwd: repoDir });
  expect(listed.worktrees).toEqual([]);
}

async function createAgentInBranchOffWorktree(options?: {
  autoArchive?: boolean;
  branchName?: string;
  repoDir?: string;
}): Promise<{ repoDir: string; agentId: string; worktreePath: string }> {
  const repoDir = options?.repoDir ?? createGitRepo();
  const branchName = options?.branchName ?? `agent-lifecycle-${Date.now()}`;
  const created = await ctx.client.createAgent({
    config: {
      ...getFullAccessConfig("codex"),
      cwd: repoDir,
    },
    worktree: {
      mode: "branch-off",
      newBranch: branchName,
      base: "main",
    },
    ...(options?.autoArchive !== undefined ? { autoArchive: options.autoArchive } : {}),
    initialPrompt: "Say done.",
  });
  return { repoDir, agentId: created.id, worktreePath: created.cwd };
}

test("create_agent_request creates a worktree and auto-archives both after the first turn", async () => {
  const repoDir = createGitRepo();
  const worktree: CreateAgentWorktreeTarget = {
    mode: "branch-off",
    newBranch: "agent-lifecycle-dispatch-test",
    base: "main",
  };
  const request: CreateAgentOptions & {
    worktree: CreateAgentWorktreeTarget;
    autoArchive: true;
  } = {
    config: {
      ...getFullAccessConfig("codex"),
      cwd: repoDir,
    },
    worktree,
    autoArchive: true,
    initialPrompt: "Say done.",
  };

  const created = await ctx.client.createAgent(request);

  expect(created.cwd).not.toBe(repoDir);
  const listedWithWorktree = await ctx.client.getPaseoWorktreeList({ cwd: repoDir });
  expect(listedWithWorktree.worktrees).toEqual([
    expect.objectContaining({
      worktreePath: created.cwd,
      branchName: "agent-lifecycle-dispatch-test",
    }),
  ]);

  await ctx.client.waitForFinish(created.id, 10000);

  // Auto-archive is asynchronous after the agent turns complete; poll until the
  // last-reference worktree directory is gone.
  await expectAgentAbsentFromActiveList(created.id);
  await expect.poll(() => existsSync(created.cwd), { timeout: 10000, interval: 100 }).toBe(false);
}, 30000);

test("create_agent_request auto-archives a nested workspace from an existing Paseo worktree", async () => {
  const repoDir = createGitRepoWithNestedDirectory();
  const source = await createAgentInBranchOffWorktree({ branchName: "nested-source", repoDir });
  await ctx.client.waitForFinish(source.agentId, 10000);
  const nestedCwd = path.join(source.worktreePath, "packages", "app");

  const created = await ctx.client.createAgent({
    config: {
      ...getFullAccessConfig("codex"),
      cwd: nestedCwd,
    },
    worktree: {
      mode: "branch-off",
      newBranch: "nested-auto-archive",
      base: "main",
    },
    autoArchive: true,
    initialPrompt: "Say done.",
  });

  const createdWorktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: created.cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();
  expect(
    createRealpathAwarePathMatcher(path.join(createdWorktreeRoot, "packages", "app"))(created.cwd),
  ).toBe(true);
  await ctx.client.waitForFinish(created.id, 10000);

  await expectAgentAbsentFromActiveList(created.id);
  await expect
    .poll(
      async () => {
        const workspaces = await ctx.client.fetchWorkspaces();
        const matchesCreatedWorkspace = createRealpathAwarePathMatcher(created.cwd);
        return workspaces.entries.some((workspace) =>
          matchesCreatedWorkspace(workspace.workspaceDirectory),
        );
      },
      { timeout: 10000, interval: 100 },
    )
    .toBe(false);
  await expect.poll(() => existsSync(created.cwd), { timeout: 10000, interval: 100 }).toBe(false);
  expect(existsSync(source.worktreePath)).toBe(true);

  await ctx.client.archivePaseoWorktree({ worktreePath: source.worktreePath });
}, 30000);

test("failed nested worktree creation cleans up the created workspace and backing directory", async () => {
  const repoDir = createGitRepoWithNestedDirectory();
  const source = await createAgentInBranchOffWorktree({
    branchName: "nested-failure-source",
    repoDir,
  });
  await ctx.client.waitForFinish(source.agentId, 10000);
  const nestedCwd = path.join(source.worktreePath, "packages", "app");

  await expect(
    ctx.client.createAgent({
      config: { provider: "unknown-provider", cwd: nestedCwd },
      worktree: {
        mode: "branch-off",
        newBranch: "nested-failure-cleanup",
        base: "main",
      },
      initialPrompt: "This agent cannot be created.",
    }),
  ).rejects.toThrow();

  await expect
    .poll(
      async () => {
        const listed = await ctx.client.getPaseoWorktreeList({ cwd: source.repoDir });
        return (
          listed.worktrees.length === 1 &&
          createRealpathAwarePathMatcher(source.worktreePath)(
            listed.worktrees[0]?.worktreePath ?? "",
          )
        );
      },
      { timeout: 10000, interval: 100 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        const workspaces = await ctx.client.fetchWorkspaces();
        return (
          workspaces.entries.length === 1 &&
          createRealpathAwarePathMatcher(source.worktreePath)(
            workspaces.entries[0]?.workspaceDirectory ?? "",
          )
        );
      },
      { timeout: 10000, interval: 100 },
    )
    .toBe(true);

  await ctx.client.archivePaseoWorktree({ worktreePath: source.worktreePath });
}, 30000);

test("create_agent_request with autoArchive archives only the agent when no worktree was created", async () => {
  const repoDir = createGitRepo();
  const created = await ctx.client.createAgent({
    config: {
      ...getFullAccessConfig("codex"),
      cwd: repoDir,
    },
    autoArchive: true,
    initialPrompt: "Say done.",
  });

  await ctx.client.waitForFinish(created.id, 10000);

  await expectAgentAbsentFromActiveList(created.id);
  const archived = await ctx.client.fetchAgents({ filter: { includeArchived: true } });
  expect(archived.entries.map((entry) => entry.agent.id)).toContain(created.id);
  const worktrees = await ctx.client.getPaseoWorktreeList({ cwd: repoDir });
  expect(worktrees.worktrees).toEqual([]);
});

test("create_agent_request with autoArchive archives an agent whose first turn fails", async () => {
  const repoDir = createGitRepo();
  const created = await ctx.client.createAgent({
    config: {
      ...getFullAccessConfig("codex"),
      cwd: repoDir,
    },
    autoArchive: true,
    initialPrompt: "Emit a turn failure.",
  });

  await ctx.client.waitForFinish(created.id, 10000);

  await expectAgentAbsentFromActiveList(created.id);
  const archived = await ctx.client.fetchAgents({ filter: { includeArchived: true } });
  expect(archived.entries.map((entry) => entry.agent.id)).toContain(created.id);
});

test("create_agent_request without autoArchive keeps today's active listing behavior", async () => {
  const repoDir = createGitRepo();
  const created = await ctx.client.createAgent({
    config: {
      ...getFullAccessConfig("codex"),
      cwd: repoDir,
    },
    initialPrompt: "Say done.",
  });

  await ctx.client.waitForFinish(created.id, 10000);

  await expectAgentPresentInActiveList(created.id);
});

test("create_agent_request with worktree but no autoArchive leaves agent and worktree active", async () => {
  const created = await createAgentInBranchOffWorktree();

  await ctx.client.waitForFinish(created.agentId, 10000);

  await expectAgentPresentInActiveList(created.agentId);
  await expectWorktreePresentInList(created.repoDir, created.worktreePath);

  await ctx.client.archivePaseoWorktree({ worktreePath: created.worktreePath });
});

test("archiving a created worktree removes the directory on last reference", async () => {
  const created = await createAgentInBranchOffWorktree();

  await ctx.client.waitForFinish(created.agentId, 10000);
  await ctx.client.archivePaseoWorktree({ worktreePath: created.worktreePath });

  await expectAgentAbsentFromActiveList(created.agentId);
  await expectWorktreeListEmpty(created.repoDir);
  expect(existsSync(created.worktreePath)).toBe(false);
});

test("auto-archiving a created worktree keeps the directory when a sibling workspace references it", async () => {
  const created = await createAgentInBranchOffWorktree({ autoArchive: true });

  // Create a sibling workspace that shares the same backing directory.
  const sibling = await ctx.client.createWorkspace({
    source: { kind: "directory", path: created.worktreePath },
    title: "sibling",
  });
  if (!sibling.workspace) {
    throw new Error(sibling.error ?? "Failed to create sibling workspace");
  }

  await ctx.client.waitForFinish(created.agentId, 10000);

  await expectAgentAbsentFromActiveList(created.agentId);
  await expectWorktreePresentInList(created.repoDir, created.worktreePath);
  expect(existsSync(created.worktreePath)).toBe(true);

  await ctx.client.archivePaseoWorktree({ worktreePath: created.worktreePath });
});

test("create_agent_request rejects legacy git options before creating a worktree", async () => {
  const repoDir = createGitRepo();

  await expect(
    ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd: repoDir,
      },
      git: {
        createNewBranch: true,
        newBranchName: "legacy-agent-branch",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch-test",
        base: "main",
      },
      initialPrompt: "Say done.",
    }),
  ).rejects.toThrow("worktree cannot be combined with git options");

  await expectActiveAgentListEmpty();
  await expectWorktreeListEmpty(repoDir);
});

test("create_agent_request fails cleanly when worktree creation cannot resolve target", async () => {
  const repoDir = createGitRepo();

  await expect(
    ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd: repoDir,
      },
      worktree: {
        mode: "checkout-branch",
        branch: "does-not-exist",
      },
      initialPrompt: "Say done.",
    }),
  ).rejects.toThrow();

  await expectActiveAgentListEmpty();
  await expectWorktreeListEmpty(repoDir);
});

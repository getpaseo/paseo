import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import type { CreateAgentOptions } from "./test-utils/index.js";
import type { CreateAgentWorktreeTarget } from "./messages.js";

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
}): Promise<{ repoDir: string; agentId: string; worktreePath: string }> {
  const repoDir = createGitRepo();
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

  // Archiving removes the task and its agents, but never deletes the worktree
  // from disk — a directory can back multiple workspaces.
  await expectAgentAbsentFromActiveList(created.id);
  await expectWorktreePresentInList(repoDir, created.cwd);
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

test("archiving a created worktree archives its agents but leaves the worktree on disk", async () => {
  const created = await createAgentInBranchOffWorktree();

  await ctx.client.waitForFinish(created.agentId, 10000);
  await ctx.client.archivePaseoWorktree({ worktreePath: created.worktreePath });

  await expectAgentAbsentFromActiveList(created.agentId);
  await expectWorktreePresentInList(created.repoDir, created.worktreePath);
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

// Model B archive is scoped to a single workspace RECORD (by workspaceId), not
// to a directory on disk. A directory can back multiple workspaces, so archiving
// one must never tear down a sibling's agents/terminals, and must never delete a
// directory another workspace still references. On-disk worktree removal is
// derived from scope + last-reference + Paseo ownership; there is no caller-
// supplied disk flag.

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

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function createGitRepo(): string {
  const tempRoot = makeTempDir("workspace-archive-repo-");
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return repoDir;
}

async function createLocalWorkspace(cwd: string, title: string): Promise<string> {
  const result = await ctx.client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title,
  });
  if (!result.workspace) {
    throw new Error(result.error ?? "Failed to create local workspace");
  }
  return result.workspace.id;
}

async function activeWorkspaceIds(): Promise<Set<string>> {
  const workspaces = await ctx.client.fetchWorkspaces();
  return new Set(workspaces.entries.map((entry) => entry.id));
}

async function activeAgentIds(): Promise<Set<string>> {
  const agents = await ctx.client.fetchAgents();
  return new Set(agents.entries.map((entry) => entry.agent.id));
}

async function archivedAgentIds(): Promise<Set<string>> {
  const agents = await ctx.client.fetchAgents({ filter: { includeArchived: true } });
  return new Set(
    agents.entries
      .filter((entry) => entry.agent.archivedAt !== null && entry.agent.archivedAt !== undefined)
      .map((entry) => entry.agent.id),
  );
}

async function terminalIdsForWorkspace(cwd: string, workspaceId: string): Promise<Set<string>> {
  const listed = await ctx.client.listTerminals(cwd, undefined, { workspaceId });
  return new Set(listed.terminals.map((terminal) => terminal.id));
}

test("archiving one of two workspaces sharing a cwd spares the sibling and the directory", async () => {
  const cwd = makeTempDir("workspace-archive-shared-cwd-");

  const workspaceA = await createLocalWorkspace(cwd, "workspace-a");
  const workspaceB = await createLocalWorkspace(cwd, "workspace-b");
  expect(workspaceA).not.toBe(workspaceB);

  const agentA = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd,
    workspaceId: workspaceA,
    title: "A agent",
    initialPrompt: "Say done.",
  });
  const agentB = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd,
    workspaceId: workspaceB,
    title: "B agent",
    initialPrompt: "Say done.",
  });
  expect(agentA.workspaceId).toBe(workspaceA);
  expect(agentB.workspaceId).toBe(workspaceB);

  const terminalA = await ctx.client.createTerminal(cwd, "A terminal", undefined, {
    workspaceId: workspaceA,
  });
  const terminalB = await ctx.client.createTerminal(cwd, "B terminal", undefined, {
    workspaceId: workspaceB,
  });
  const terminalAId = terminalA.terminal?.id;
  const terminalBId = terminalB.terminal?.id;
  if (!terminalAId || !terminalBId) {
    throw new Error("Expected both terminals to be created");
  }

  // Both workspaces, both agents, and both terminals exist before the archive.
  expect(await activeWorkspaceIds()).toContain(workspaceA);
  expect(await activeWorkspaceIds()).toContain(workspaceB);
  expect(await activeAgentIds()).toContain(agentA.id);
  expect(await activeAgentIds()).toContain(agentB.id);
  expect(await terminalIdsForWorkspace(cwd, workspaceA)).toContain(terminalAId);
  expect(await terminalIdsForWorkspace(cwd, workspaceB)).toContain(terminalBId);

  // Archive workspace A by its workspaceId. Because two workspaces share the cwd,
  // teardown must be scoped to A's workspaceId, not the directory.
  const archive = await ctx.client.archiveWorkspace(workspaceA);
  expect(archive.error).toBe(null);

  await expect
    .poll(async () => (await activeWorkspaceIds()).has(workspaceA), {
      timeout: 10000,
      interval: 100,
    })
    .toBe(false);

  // A's record is gone; B's survives.
  const remainingWorkspaces = await activeWorkspaceIds();
  expect(remainingWorkspaces.has(workspaceA)).toBe(false);
  expect(remainingWorkspaces.has(workspaceB)).toBe(true);

  // A's agent is archived; B's agent stays active.
  expect((await activeAgentIds()).has(agentA.id)).toBe(false);
  expect(await archivedAgentIds()).toContain(agentA.id);
  expect((await activeAgentIds()).has(agentB.id)).toBe(true);

  // A's terminal is killed; B's terminal survives.
  expect((await terminalIdsForWorkspace(cwd, workspaceA)).has(terminalAId)).toBe(false);
  expect((await terminalIdsForWorkspace(cwd, workspaceB)).has(terminalBId)).toBe(true);

  // The shared directory is never deleted — a sibling still references it.
  expect(existsSync(cwd)).toBe(true);

  await ctx.client.killTerminal(terminalBId);
}, 60000);

test("archiving the last reference to a worktree removes it from disk regardless of the disk flag", async () => {
  const repoDir = createGitRepo();

  const keepResult = await ctx.client.createWorkspace({
    source: { kind: "worktree", cwd: repoDir, worktreeSlug: "keep-on-disk", baseBranch: "main" },
  });
  const keepWorkspace = keepResult.workspace;
  if (!keepWorkspace?.workspaceDirectory) {
    throw new Error(keepResult.error ?? "Failed to create worktree workspace");
  }
  const keepDir = keepWorkspace.workspaceDirectory;
  expect(existsSync(keepDir)).toBe(true);

  // Last reference, deleteWorktreeFromDisk omitted (defaults ignored) → dir removed.
  const keepArchive = await ctx.client.archivePaseoWorktree({ worktreePath: keepDir });
  expect(keepArchive.success).toBe(true);
  await expect
    .poll(async () => (await activeWorkspaceIds()).has(keepWorkspace.id), {
      timeout: 10000,
      interval: 100,
    })
    .toBe(false);
  await expect.poll(() => existsSync(keepDir), { timeout: 10000, interval: 100 }).toBe(false);

  const deleteResult = await ctx.client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: repoDir,
      worktreeSlug: "delete-from-disk",
      baseBranch: "main",
    },
  });
  const deleteWorkspace = deleteResult.workspace;
  if (!deleteWorkspace?.workspaceDirectory) {
    throw new Error(deleteResult.error ?? "Failed to create worktree workspace");
  }
  const deleteDir = deleteWorkspace.workspaceDirectory;
  expect(existsSync(deleteDir)).toBe(true);

  // Last reference on a fresh worktree still removes the directory without any
  // caller-supplied disk-deletion flag.
  const deleteArchive = await ctx.client.archivePaseoWorktree({ worktreePath: deleteDir });
  expect(deleteArchive.success).toBe(true);
  await expect
    .poll(async () => (await activeWorkspaceIds()).has(deleteWorkspace.id), {
      timeout: 10000,
      interval: 100,
    })
    .toBe(false);
  await expect.poll(() => existsSync(deleteDir), { timeout: 10000, interval: 100 }).toBe(false);
}, 60000);

test("worktree archive targets the explicit workspaceId when a directory backs multiple workspaces", async () => {
  const repoDir = createGitRepo();

  const worktreeResult = await ctx.client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: repoDir,
      worktreeSlug: "targeted-worktree",
      baseBranch: "main",
    },
  });
  const worktreeWorkspace = worktreeResult.workspace;
  if (!worktreeWorkspace?.workspaceDirectory) {
    throw new Error(worktreeResult.error ?? "Failed to create worktree workspace");
  }
  const worktreeDir = worktreeWorkspace.workspaceDirectory;

  // A local workspace records the SAME directory as its cwd. Resolving the
  // archive target by cwd alone is ambiguous; the explicit workspaceId must win.
  const localWorkspaceId = await createLocalWorkspace(worktreeDir, "local-sibling");
  expect(localWorkspaceId).not.toBe(worktreeWorkspace.id);

  const archive = await ctx.client.archivePaseoWorktree({
    worktreePath: worktreeDir,
    workspaceId: localWorkspaceId,
  });
  expect(archive.success).toBe(true);

  // Exactly the targeted workspace is archived; the worktree-backed sibling stays.
  await expect
    .poll(async () => (await activeWorkspaceIds()).has(localWorkspaceId), {
      timeout: 10000,
      interval: 100,
    })
    .toBe(false);
  const remaining = await activeWorkspaceIds();
  expect(remaining.has(localWorkspaceId)).toBe(false);
  expect(remaining.has(worktreeWorkspace.id)).toBe(true);
  expect(existsSync(worktreeDir)).toBe(true);

  await ctx.client.archivePaseoWorktree({
    worktreePath: worktreeDir,
    workspaceId: worktreeWorkspace.id,
  });
}, 60000);

test("keeps the worktree on disk when a sibling workspace still references it", async () => {
  const repoDir = createGitRepo();

  const worktreeResult = await ctx.client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: repoDir,
      worktreeSlug: "shared-worktree",
      baseBranch: "main",
    },
  });
  const worktreeWorkspace = worktreeResult.workspace;
  if (!worktreeWorkspace?.workspaceDirectory) {
    throw new Error(worktreeResult.error ?? "Failed to create worktree workspace");
  }
  const worktreeDir = worktreeWorkspace.workspaceDirectory;
  expect(existsSync(worktreeDir)).toBe(true);

  // A second workspace records the SAME worktree directory as its cwd.
  const siblingWorkspaceId = await createLocalWorkspace(worktreeDir, "sibling");
  expect(siblingWorkspaceId).not.toBe(worktreeWorkspace.id);

  // Archive the worktree-backed workspace. It is NOT the last reference, so the
  // directory must survive regardless of the legacy disk flag.
  const archive = await ctx.client.archivePaseoWorktree({
    worktreePath: worktreeDir,
  });
  expect(archive.success).toBe(true);

  await expect
    .poll(async () => (await activeWorkspaceIds()).has(worktreeWorkspace.id), {
      timeout: 10000,
      interval: 100,
    })
    .toBe(false);

  const remaining = await activeWorkspaceIds();
  expect(remaining.has(worktreeWorkspace.id)).toBe(false);
  expect(remaining.has(siblingWorkspaceId)).toBe(true);
  expect(existsSync(worktreeDir)).toBe(true);
}, 60000);

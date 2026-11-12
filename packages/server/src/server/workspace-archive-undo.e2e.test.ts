import { DaemonClient } from "./test-utils/daemon-client.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

// Undo of a workspace archive, end to end through a real daemon. The archive is parked inside a
// worktree teardown command that waits on a file, so the undo lands at a known point.

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

interface GatedRepo {
  repoDir: string;
  teardownStartedPath: string;
  releaseTeardown: () => void;
}

function git(repoDir: string, args: string[]): void {
  execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
}

/** A repo whose worktree teardown parks until released. */
function createRepoWithGatedTeardown(): GatedRepo {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "workspace-archive-undo-"));
  tempRoots.push(tempRoot);
  const repoDir = path.join(tempRoot, "repo");
  const teardownStartedPath = path.join(tempRoot, "teardown-started");
  const releasePath = path.join(tempRoot, "release-teardown");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  git(repoDir, ["config", "user.email", "test@getpaseo.local"]);
  git(repoDir, ["config", "user.name", "Paseo Test"]);
  const teardown = `node -e "const fs=require('fs');fs.writeFileSync('${teardownStartedPath}','started');const timer=setInterval(()=>{if(fs.existsSync('${releasePath}'))clearInterval(timer)},20)"`;
  writeFileSync(
    path.join(repoDir, "paseo.json"),
    JSON.stringify({ worktree: { teardown: [teardown] } }),
  );
  git(repoDir, ["add", "paseo.json"]);
  git(repoDir, ["-c", "commit.gpgsign=false", "commit", "-m", "gated teardown"]);
  return {
    repoDir,
    teardownStartedPath,
    releaseTeardown: () => writeFileSync(releasePath, "release\n"),
  };
}

async function createWorktreeWorkspaceWithAgent(repoDir: string, slug: string) {
  const result = await ctx.client.createWorkspace({
    source: { kind: "worktree", cwd: repoDir, worktreeSlug: slug, baseBranch: "main" },
  });
  const workspace = result.workspace;
  if (!workspace?.workspaceDirectory) {
    throw new Error(result.error ?? "Failed to create worktree workspace");
  }
  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd: workspace.workspaceDirectory,
    workspaceId: workspace.id,
    title: "Undo agent",
  });
  return { workspaceId: workspace.id, directory: workspace.workspaceDirectory, agentId: agent.id };
}

async function isWorkspaceActive(workspaceId: string): Promise<boolean> {
  const workspaces = await ctx.client.fetchWorkspaces();
  return workspaces.entries.some((entry) => entry.id === workspaceId);
}

async function isAgentArchived(agentId: string): Promise<boolean> {
  const agents = await ctx.client.fetchAgents({ filter: { includeArchived: true } });
  const entry = agents.entries.find((candidate) => candidate.agent.id === agentId);
  if (!entry) throw new Error(`Agent ${agentId} is missing`);
  return entry.agent.archivedAt !== null && entry.agent.archivedAt !== undefined;
}

test.skipIf(process.platform === "win32")(
  "an undo while teardown runs cancels the archive before the worktree is deleted",
  async () => {
    const repo = createRepoWithGatedTeardown();
    const { workspaceId, directory, agentId } = await createWorktreeWorkspaceWithAgent(
      repo.repoDir,
      "undo-during-teardown",
    );

    try {
      const archive = ctx.client.archiveWorkspace(workspaceId);
      await expect.poll(() => existsSync(repo.teardownStartedPath), { timeout: 15000 }).toBe(true);
      const undo = ctx.client.undoWorkspaceArchive(workspaceId);
      repo.releaseTeardown();

      const [archiveResponse] = await Promise.all([archive, undo]);

      expect({
        canceled: archiveResponse.canceled,
        archivedAt: archiveResponse.archivedAt,
        workspaceActive: await isWorkspaceActive(workspaceId),
        directoryExists: existsSync(directory),
        agentArchived: await isAgentArchived(agentId),
      }).toEqual({
        canceled: true,
        archivedAt: null,
        workspaceActive: true,
        directoryExists: true,
        agentArchived: false,
      });
    } finally {
      repo.releaseTeardown();
    }
  },
  60000,
);

test.skipIf(process.platform === "win32")(
  "an undo after the archive finished recreates the worktree and its agents",
  async () => {
    const repo = createRepoWithGatedTeardown();
    repo.releaseTeardown();
    const { workspaceId, directory, agentId } = await createWorktreeWorkspaceWithAgent(
      repo.repoDir,
      "undo-after-archive",
    );

    const archived = await ctx.client.archiveWorkspace(workspaceId);
    expect(archived.error).toBeNull();
    expect(existsSync(directory)).toBe(false);
    expect(await isAgentArchived(agentId)).toBe(true);

    await ctx.client.undoWorkspaceArchive(workspaceId);

    expect({
      workspaceActive: await isWorkspaceActive(workspaceId),
      directoryExists: existsSync(directory),
      agentArchived: await isAgentArchived(agentId),
    }).toEqual({ workspaceActive: true, directoryExists: true, agentArchived: false });
  },
  60000,
);

test.skipIf(process.platform === "win32")(
  "archive, undo, archive leaves the workspace archived",
  async () => {
    const repo = createRepoWithGatedTeardown();
    const { workspaceId, directory, agentId } = await createWorktreeWorkspaceWithAgent(
      repo.repoDir,
      "archive-undo-archive",
    );

    try {
      const first = ctx.client.archiveWorkspace(workspaceId);
      await expect.poll(() => existsSync(repo.teardownStartedPath), { timeout: 15000 }).toBe(true);
      const undo = ctx.client.undoWorkspaceArchive(workspaceId);
      const second = ctx.client.archiveWorkspace(workspaceId);
      repo.releaseTeardown();

      const [firstResponse, , secondResponse] = await Promise.all([first, undo, second]);

      expect({
        firstCanceled: firstResponse.canceled,
        secondError: secondResponse.error,
        secondCanceled: secondResponse.canceled ?? false,
        workspaceActive: await isWorkspaceActive(workspaceId),
        directoryExists: existsSync(directory),
        agentArchived: await isAgentArchived(agentId),
      }).toEqual({
        firstCanceled: true,
        secondError: null,
        secondCanceled: false,
        workspaceActive: false,
        directoryExists: false,
        agentArchived: true,
      });
    } finally {
      repo.releaseTeardown();
    }
  },
  60000,
);

test.skipIf(process.platform === "win32")(
  "an undo sent right behind its archive leaves the workspace active",
  async () => {
    const repo = createRepoWithGatedTeardown();
    repo.releaseTeardown();
    const { workspaceId, directory, agentId } = await createWorktreeWorkspaceWithAgent(
      repo.repoDir,
      "archive-then-undo-same-tick",
    );

    const [archiveResponse] = await Promise.all([
      ctx.client.archiveWorkspace(workspaceId),
      ctx.client.undoWorkspaceArchive(workspaceId),
    ]);

    expect({
      archiveCanceled: archiveResponse.canceled ?? false,
      workspaceActive: await isWorkspaceActive(workspaceId),
      directoryExists: existsSync(directory),
      agentArchived: await isAgentArchived(agentId),
    }).toEqual({
      archiveCanceled: true,
      workspaceActive: true,
      directoryExists: true,
      agentArchived: false,
    });
  },
  60000,
);

test.skipIf(process.platform === "win32")(
  "the undo response arrives after the client has seen its agents restored",
  async () => {
    const repo = createRepoWithGatedTeardown();
    repo.releaseTeardown();
    const { workspaceId, agentId } = await createWorktreeWorkspaceWithAgent(
      repo.repoDir,
      "undo-update-order",
    );
    await ctx.client.fetchAgents({ subscribe: {} });
    // An archived agent leaves a default subscription; a restored one comes back as active.
    let seenState: "active" | "archived" | "removed" = "active";
    const stop = ctx.client.on("agent_update", (message) => {
      if (message.payload.kind === "remove" && message.payload.agentId === agentId) {
        seenState = "removed";
      }
      if (message.payload.kind === "upsert" && message.payload.agent.id === agentId) {
        seenState = message.payload.agent.archivedAt ? "archived" : "active";
      }
    });

    try {
      await ctx.client.archiveWorkspace(workspaceId);
      await expect.poll(() => seenState, { timeout: 15000 }).not.toBe("active");

      await ctx.client.undoWorkspaceArchive(workspaceId);

      // An app holds its agent tabs open until this response; an agent it still sees as
      // archived at that point gets its tab closed.
      expect(seenState).toBe("active");
    } finally {
      stop();
    }
  },
  60000,
);

test("an undo on a workspace that was never archived leaves it as it was", async () => {
  const repo = createRepoWithGatedTeardown();
  repo.releaseTeardown();
  const { workspaceId, directory, agentId } = await createWorktreeWorkspaceWithAgent(
    repo.repoDir,
    "undo-without-archive",
  );

  await ctx.client.undoWorkspaceArchive(workspaceId);

  expect({
    workspaceActive: await isWorkspaceActive(workspaceId),
    directoryExists: existsSync(directory),
    agentArchived: await isAgentArchived(agentId),
  }).toEqual({ workspaceActive: true, directoryExists: true, agentArchived: false });
}, 60000);

test.each(["restore", "undo", "reopen", "refresh", "legacy"] as const)(
  "%s after a daemon restart returns the archive's agents and leaves earlier closed agents archived",
  async (route) => {
    const artifacts = path.resolve(import.meta.dirname, "../../../../.artifacts");
    mkdirSync(artifacts, { recursive: true });
    const tempRoot = mkdtempSync(path.join(artifacts, "archive-restart-"));
    tempRoots.push(tempRoot);
    const repoDir = path.join(tempRoot, "repo");
    git(tempRoot, ["init", "-b", "main", repoDir]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    await ctx.cleanup();
    ctx = await createDaemonTestContext({
      paseoHomeRoot: path.join(tempRoot, "home"),
      cleanup: false,
    });
    const created = await ctx.client.createWorkspace({
      source: { kind: "directory", path: repoDir },
    });
    const workspaceId = created.workspace!.id;
    const agents = [];
    for (const title of ["A", "B", "C"]) {
      agents.push(
        await ctx.client.createAgent({
          ...getFullAccessConfig("codex"),
          cwd: repoDir,
          workspaceId,
          title,
        }),
      );
    }
    const [a, b, c] = agents;
    if (!a || !b || !c) throw new Error("Expected three agents");
    await ctx.daemon.daemon.agentManager.archiveAgent(c.id, "2020-01-01T00:00:00.000Z");
    const archive = await ctx.client.archiveWorkspace(workspaceId);
    if (route === "legacy") {
      const stamp = new Date(Date.parse(archive.archivedAt!) - 1000).toISOString();
      await ctx.daemon.daemon.agentManager.archiveSnapshot(a.id, stamp);
      await ctx.daemon.daemon.agentManager.archiveSnapshot(b.id, stamp);
    }
    await ctx.cleanup();
    ctx = await createDaemonTestContext({
      paseoHomeRoot: path.join(tempRoot, "home"),
      cleanup: false,
    });
    expect(await isAgentArchived(a.id)).toBe(true);
    if (route === "restore" || route === "legacy") await ctx.client.restoreWorkspace(workspaceId);
    if (route === "undo") await ctx.client.undoWorkspaceArchive(workspaceId);
    if (route === "reopen") await ctx.client.openProject(repoDir);
    if (route === "refresh") {
      const legacy = new DaemonClient({
        url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
        appVersion: "0.1.104",
      });
      await legacy.connect();
      try {
        await legacy.refreshAgent(a.id);
      } finally {
        await legacy.close();
      }
    }
    expect(await isWorkspaceActive(workspaceId)).toBe(true);
    expect(await isAgentArchived(a.id)).toBe(false);
    expect(await isAgentArchived(b.id)).toBe(false);
    expect(await isAgentArchived(c.id)).toBe(true);
  },
  60000,
);

test.skipIf(process.platform === "win32")(
  "a failed worktree restore leaves every agent archived until retry succeeds",
  async () => {
    const repo = createRepoWithGatedTeardown();
    repo.releaseTeardown();
    const { workspaceId, agentId } = await createWorktreeWorkspaceWithAgent(
      repo.repoDir,
      "restore-retry",
    );
    await ctx.client.archiveWorkspace(workspaceId);
    const displaced = repo.repoDir + "-unavailable";
    renameSync(repo.repoDir, displaced);
    try {
      await expect(ctx.client.restoreWorkspace(workspaceId)).rejects.toThrow("source repository");
      expect(await isWorkspaceActive(workspaceId)).toBe(false);
      expect(await isAgentArchived(agentId)).toBe(true);
    } finally {
      renameSync(displaced, repo.repoDir);
    }
    await ctx.client.restoreWorkspace(workspaceId);
    expect(await isWorkspaceActive(workspaceId)).toBe(true);
    expect(await isAgentArchived(agentId)).toBe(false);
  },
  60000,
);

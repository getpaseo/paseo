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

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

function commitWork(directory: string, file: string): string {
  mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  writeFileSync(path.join(directory, file), "work\n");
  git(directory, ["add", file]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", `work on ${file}`]);
  return gitOutput(directory, ["rev-parse", "HEAD"]);
}

// What HEAD was at archive, and what the repository did with its branch while archived.
const archivedHeadCases = [
  { name: "detached", detach: true, afterArchive: "nothing", comesBackOn: "" },
  { name: "on a branch", detach: false, afterArchive: "nothing", comesBackOn: "branch" },
  { name: "on a branch that moved", detach: false, afterArchive: "move", comesBackOn: "" },
  { name: "on a branch that was deleted", detach: false, afterArchive: "delete", comesBackOn: "" },
] as const;

for (const route of ["undo", "restore"] as const) {
  test.skipIf(process.platform === "win32").each(archivedHeadCases)(
    `${route} brings back a worktree archived $name at the commit it was on`,
    async ({ detach, afterArchive, comesBackOn }) => {
      const repo = createRepoWithGatedTeardown();
      repo.releaseTeardown();
      const { workspaceId, directory } = await createWorktreeWorkspaceWithAgent(
        repo.repoDir,
        `archived-head-${route}`,
      );
      const branch = gitOutput(directory, ["branch", "--show-current"]);
      if (detach) git(directory, ["checkout", "--detach"]);
      const archivedCommit = commitWork(directory, "work.txt");

      const archived = await ctx.client.archiveWorkspace(workspaceId);
      expect(archived.error).toBeNull();
      expect(existsSync(directory)).toBe(false);
      if (afterArchive === "move") git(repo.repoDir, ["branch", "-f", branch, "main"]);
      if (afterArchive === "delete") git(repo.repoDir, ["branch", "-D", branch]);
      const branchTip =
        afterArchive === "move" ? gitOutput(repo.repoDir, ["rev-parse", branch]) : null;
      collectUnreachableCommits(repo.repoDir);

      if (route === "undo") await ctx.client.undoWorkspaceArchive(workspaceId);
      else await ctx.client.restoreWorkspace(workspaceId);

      expect({
        workspaceActive: await isWorkspaceActive(workspaceId),
        head: gitOutput(directory, ["rev-parse", "HEAD"]),
        branch: gitOutput(directory, ["branch", "--show-current"]),
        branchTip: branchTip && gitOutput(repo.repoDir, ["rev-parse", branch]),
        savedHeads: gitOutput(repo.repoDir, ["for-each-ref", "refs/paseo"]),
      }).toEqual({
        workspaceActive: true,
        head: archivedCommit,
        branch: comesBackOn === "branch" ? branch : "",
        branchTip,
        savedHeads: "",
      });
    },
    60000,
  );
}

function commitOnDetachedHead(directory: string, file: string): string {
  git(directory, ["checkout", "--detach"]);
  return commitWork(directory, file);
}

function collectUnreachableCommits(repoDir: string): void {
  git(repoDir, ["reflog", "expire", "--expire-unreachable=now", "--all"]);
  git(repoDir, ["gc", "--prune=now", "--quiet"]);
}

test.skipIf(process.platform === "win32")(
  "archiving again to clean up a folder a failed teardown left keeps its detached commit",
  async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "workspace-archive-cleanup-"));
    tempRoots.push(tempRoot);
    const repoDir = path.join(tempRoot, "repo");
    execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
    git(repoDir, ["config", "user.email", "test@getpaseo.local"]);
    git(repoDir, ["config", "user.name", "Paseo Test"]);
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({ worktree: { teardown: ["exit 1"] } }),
    );
    git(repoDir, ["add", "paseo.json"]);
    git(repoDir, ["-c", "commit.gpgsign=false", "commit", "-m", "failing teardown"]);
    const { workspaceId, directory } = await createWorktreeWorkspaceWithAgent(
      repoDir,
      "cleanup-archive",
    );
    const detachedCommit = commitOnDetachedHead(directory, "detached.txt");

    await ctx.client.archiveWorkspace(workspaceId);
    expect(existsSync(directory)).toBe(true);
    await ctx.client.archiveWorkspace(workspaceId);
    expect(existsSync(directory)).toBe(false);
    collectUnreachableCommits(repoDir);
    await ctx.client.restoreWorkspace(workspaceId);

    expect({
      workspaceActive: await isWorkspaceActive(workspaceId),
      head: gitOutput(directory, ["rev-parse", "HEAD"]),
      savedHeads: gitOutput(repoDir, ["for-each-ref", "refs/paseo"]),
    }).toEqual({ workspaceActive: true, head: detachedCommit, savedHeads: "" });
  },
  60000,
);

test.skipIf(process.platform === "win32")(
  "restoring a worktree archived on a branch opens the new worktree that checked the branch out",
  async () => {
    const repo = createRepoWithGatedTeardown();
    repo.releaseTeardown();
    const created = await ctx.client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repo.repoDir,
        action: "branch-off",
        branchName: "reused-branch",
        baseBranch: "main",
      },
    });
    const archivedId = created.workspace?.id;
    const archivedDirectory = created.workspace?.workspaceDirectory;
    if (!archivedId || !archivedDirectory) throw new Error(created.error ?? "Failed to create");
    const commit = commitWork(archivedDirectory, "work.txt");
    await ctx.client.archiveWorkspace(archivedId);
    const reopened = await ctx.client.createWorkspace({
      source: { kind: "worktree", cwd: repo.repoDir, action: "checkout", refName: "reused-branch" },
    });

    await ctx.client.restoreWorkspace(archivedId);

    expect({
      reopenedDirectory: reopened.workspace?.workspaceDirectory,
      archivedActive: await isWorkspaceActive(archivedId),
      reopenedActive: await isWorkspaceActive(reopened.workspace?.id ?? ""),
      head: gitOutput(archivedDirectory, ["rev-parse", "HEAD"]),
      branch: gitOutput(archivedDirectory, ["branch", "--show-current"]),
      savedHeads: gitOutput(repo.repoDir, ["for-each-ref", "refs/paseo"]),
    }).toEqual({
      reopenedDirectory: archivedDirectory,
      archivedActive: true,
      reopenedActive: true,
      head: commit,
      branch: "reused-branch",
      savedHeads: "",
    });
  },
  60000,
);

test.skipIf(process.platform === "win32").each([
  ["root", "subdirectory"],
  ["subdirectory", "root"],
] as const)(
  "restoring the %s workspace first brings back the detached commit of a worktree two workspaces share",
  async (first, second) => {
    const repo = createRepoWithGatedTeardown();
    repo.releaseTeardown();
    const root = await createWorktreeWorkspaceWithAgent(repo.repoDir, `shared-${first}`);
    const detachedCommit = commitOnDetachedHead(root.directory, "sub/detached.txt");
    const opened = await ctx.client.createWorkspace({
      source: { kind: "directory", path: path.join(root.directory, "sub") },
    });
    const subdirectoryId = opened.workspace?.id;
    if (!subdirectoryId) throw new Error(opened.error ?? "Failed to open the subdirectory");
    const workspaceIds = { root: root.workspaceId, subdirectory: subdirectoryId };

    await ctx.client.archiveWorkspace(workspaceIds.root);
    expect(existsSync(root.directory)).toBe(true);
    await ctx.client.archiveWorkspace(workspaceIds.subdirectory);
    expect(existsSync(root.directory)).toBe(false);
    collectUnreachableCommits(repo.repoDir);
    await ctx.client.restoreWorkspace(workspaceIds[first]);
    await ctx.client.restoreWorkspace(workspaceIds[second]);

    expect({
      rootActive: await isWorkspaceActive(workspaceIds.root),
      subdirectoryActive: await isWorkspaceActive(workspaceIds.subdirectory),
      head: gitOutput(root.directory, ["rev-parse", "HEAD"]),
      savedHeads: gitOutput(repo.repoDir, ["for-each-ref", "refs/paseo"]),
    }).toEqual({
      rootActive: true,
      subdirectoryActive: true,
      head: detachedCommit,
      savedHeads: "",
    });
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import {
  createDaemonTestContext,
  DaemonClient,
  type DaemonTestContext,
} from "./test-utils/index.js";
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
  initialPrompt?: string;
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
    initialPrompt: options?.initialPrompt ?? "Say done.",
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
  expect(listedWithWorktree.worktrees).toHaveLength(1);
  const listedWorktree = listedWithWorktree.worktrees[0];
  expect(listedWorktree?.branchName).toBe("agent-lifecycle-dispatch-test");
  expect(createRealpathAwarePathMatcher(created.cwd)(listedWorktree?.worktreePath ?? "")).toBe(
    true,
  );

  await ctx.client.waitForFinish(created.id, 10000);

  // Auto-archive is asynchronous after the agent turns complete; poll until the
  // last-reference worktree directory is gone.
  await expectAgentAbsentFromActiveList(created.id);
  await expect.poll(() => existsSync(created.cwd), { timeout: 10000, interval: 100 }).toBe(false);
  // Archived tabs can continue asking for history, and those reads are served from
  // persisted state. They must not recreate the removed worktree or its workspace
  // observation, and must not compromise the next agent lifecycle.
  const staleTimelineReads = await Promise.allSettled(
    Array.from({ length: 10 }, () => ctx.client.fetchAgentTimeline(created.id, { limit: 20 })),
  );
  expect(staleTimelineReads.every((result) => result.status === "fulfilled")).toBe(true);
  expect(existsSync(created.cwd)).toBe(false);
  expect((await ctx.client.fetchWorkspaces()).entries).toHaveLength(0);
  const subsequent = await ctx.client.createAgent({
    config: { ...getFullAccessConfig("codex"), cwd: repoDir },
    initialPrompt: "Say done.",
  });
  await ctx.client.waitForFinish(subsequent.id, 10_000);
  await expectAgentPresentInActiveList(subsequent.id);
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
  // Hold turn completion while establishing the sibling reference. The original
  // ordering raced a fast completed turn against sibling workspace creation.
  await ctx.cleanup();
  let finishTurn!: () => void;
  const completion = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      beforeTurnComplete: async (prompt) => {
        if (prompt === "Hold for sibling workspace") await completion;
      },
    }),
  });
  try {
    const created = await createAgentInBranchOffWorktree({
      autoArchive: true,
      initialPrompt: "Hold for sibling workspace",
    });
    const sibling = await ctx.client.createWorkspace({
      source: { kind: "directory", path: created.worktreePath },
      title: "sibling",
    });
    if (!sibling.workspace) throw new Error(sibling.error ?? "Failed to create sibling workspace");
    finishTurn();
    await ctx.client.waitForFinish(created.agentId, 10000);
    await expectAgentAbsentFromActiveList(created.agentId);
    await expectWorktreePresentInList(created.repoDir, created.worktreePath);
    expect(existsSync(created.worktreePath)).toBe(true);
    await ctx.client.archivePaseoWorktree({ worktreePath: created.worktreePath });
  } finally {
    finishTurn();
  }
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

/** Every agent id with a record under `$PASEO_HOME/agents`, whatever its cwd bucket. */
function storedAgentIds(): string[] {
  const root = path.join(ctx.daemon.paseoHome, "agents");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.basename(entry, ".json"));
}

test.each(["git", "worktreeName"] as const)(
  "legacy %s worktree creation resolves final workspace visibility without intermediate records",
  async (placement) => {
    const cwd = createGitRepo();
    const config = { ...getFullAccessConfig("codex"), cwd };
    const backgroundCaller = await ctx.client.createAgent({ config, background: true });
    const visibleCaller = await ctx.client.createAgent({ config });
    const cases = [
      { name: "review", background: true, expected: true },
      { name: "review-child", callerAgentId: backgroundCaller.id, expected: true },
      {
        name: "visible-child",
        callerAgentId: backgroundCaller.id,
        background: false,
        expected: false,
      },
      { name: "hidden-child", callerAgentId: visibleCaller.id, background: true, expected: true },
      { name: "human-default", expected: false },
    ];
    const orderedCases =
      placement === "worktreeName" ? [cases[1]!, cases[0]!, ...cases.slice(2)] : cases;
    for (const entry of orderedCases) {
      const before = await ctx.client.fetchWorkspaces({ filter: { includeBackground: true } });
      const child = await ctx.client.createAgent({
        config,
        ...(entry.callerAgentId ? { callerAgentId: entry.callerAgentId } : {}),
        ...(entry.background !== undefined ? { background: entry.background } : {}),
        ...(placement === "git"
          ? {
              git: {
                createWorktree: true,
                createNewBranch: true,
                newBranchName: entry.name,
                baseBranch: "main",
              },
            }
          : { worktreeName: entry.name }),
      });
      const inclusive = await ctx.client.fetchWorkspaces({ filter: { includeBackground: true } });
      const created = inclusive.entries.filter(
        (workspace) => !before.entries.some((existing) => existing.id === workspace.id),
      );
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        id: child.workspaceId,
        workspaceDirectory: child.cwd,
        background: entry.expected,
        workspaceKind: "worktree",
      });
      expect(child.cwd).not.toBe(cwd);
      expect(child.labels?.["paseo.parent-agent-id"]).toBe(entry.callerAgentId);
      const defaultAgents = await ctx.client.fetchAgents();
      const allAgents = await ctx.client.fetchAgents({ filter: { includeBackground: true } });
      expect(defaultAgents.entries.some((item) => item.agent.id === child.id)).toBe(
        !entry.expected,
      );
      expect(allAgents.entries.some((item) => item.agent.id === child.id)).toBe(true);
      const defaultWorkspaces = await ctx.client.fetchWorkspaces();
      expect(
        defaultWorkspaces.entries.some((workspace) => workspace.id === child.workspaceId),
      ).toBe(!entry.expected);
    }
  },
  30_000,
);

test("background workspaces keep durable agents addressable through restart and archive", async () => {
  const cwd = createGitRepo();
  const config = { ...getFullAccessConfig("codex"), cwd };
  const hidden = await ctx.client.createAgent({
    config,
    background: true,
    idempotencyKey: "background-durable",
  });
  expect(hidden.internal).not.toBe(true);
  expect(
    (await ctx.client.fetchWorkspaces({ filter: { query: hidden.workspaceId } })).entries.map(
      (entry) => entry.id,
    ),
  ).toContain(hidden.workspaceId);
  expect(storedAgentIds()).toContain(hidden.id);
  expect((await ctx.client.fetchWorkspaces()).entries).not.toContainEqual(
    expect.objectContaining({ id: hidden.workspaceId }),
  );
  expect(
    (await ctx.client.fetchWorkspaces({ filter: { includeBackground: true } })).entries,
  ).toContainEqual(expect.objectContaining({ id: hidden.workspaceId, background: true }));
  expect((await ctx.client.fetchAgents()).entries.map((entry) => entry.agent.id)).not.toContain(
    hidden.id,
  );
  expect(
    (await ctx.client.fetchAgents({ filter: { includeBackground: true } })).entries.map(
      (entry) => entry.agent.id,
    ),
  ).toContain(hidden.id);
  const child = await ctx.client.createAgent({ config, callerAgentId: hidden.id });
  expect(child.workspaceId).toBe(hidden.workspaceId);
  const inherited = await ctx.client.createWorkspace({
    source: { kind: "directory", path: cwd },
    callerAgentId: hidden.id,
  });
  expect(inherited.workspace?.background).toBe(true);
  const visible = await ctx.client.createWorkspace({
    source: { kind: "directory", path: cwd },
    callerAgentId: hidden.id,
    background: false,
  });
  expect(visible.workspace?.background).toBe(false);
  const inheritedWorktree = await ctx.client.createAgent({
    config,
    callerAgentId: hidden.id,
    worktree: { mode: "branch-off", newBranch: "background-child", base: "main" },
  });
  const overriddenWorktree = await ctx.client.createAgent({
    config,
    callerAgentId: hidden.id,
    background: false,
    worktree: { mode: "branch-off", newBranch: "visible-child", base: "main" },
  });
  const workspaces = (await ctx.client.fetchWorkspaces({ filter: { includeBackground: true } }))
    .entries;
  expect(workspaces.find((entry) => entry.id === inheritedWorktree.workspaceId)?.background).toBe(
    true,
  );
  expect(workspaces.find((entry) => entry.id === overriddenWorktree.workspaceId)?.background).toBe(
    false,
  );

  await expect(
    ctx.client.createAgent({ config, workspaceId: hidden.workspaceId, background: false }),
  ).rejects.toThrow("workspace creation intent");
  await ctx.client.sendAgentMessage(hidden.id, "Say done.");
  await ctx.client.waitForFinish(hidden.id, 10_000);
  expect(
    (await ctx.client.fetchAgentTimeline(hidden.id, { limit: 20 })).entries.length,
  ).toBeGreaterThan(0);
  const homeRoot = path.dirname(ctx.daemon.paseoHome);
  tempRoots.push(ctx.daemon.staticDir);
  await ctx.client.close();
  await ctx.daemon.daemon.stop();
  await ctx.daemon.daemon.agentManager.flush();
  ctx = await createDaemonTestContext({ paseoHomeRoot: homeRoot });
  const replay = await ctx.client.createAgent({
    config,
    background: true,
    idempotencyKey: "background-durable",
  });
  expect(replay.id).toBe(hidden.id);
  expect((await ctx.client.fetchAgent(hidden.id))?.agent.workspaceId).toBe(hidden.workspaceId);
  await ctx.client.sendAgentMessage(hidden.id, "Say done again.");
  await ctx.client.waitForFinish(hidden.id, 10_000);
  await ctx.client.archiveAgent(hidden.id);
  expect((await ctx.client.fetchAgent(hidden.id))?.agent.archivedAt).toEqual(expect.any(String));
  expect(
    (await ctx.client.fetchAgentHistory()).entries.map((entry) => entry.agent.id),
  ).not.toContain(hidden.id);
  expect(
    (await ctx.client.fetchAgentHistory({ filter: { includeBackground: true } })).entries.map(
      (entry) => entry.agent.id,
    ),
  ).toContain(hidden.id);
}, 30_000);

test("default and inclusive observers retain independent snapshots, live updates and catch-up", async () => {
  const otherClient = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await otherClient.connect();
  try {
    const cwd = createGitRepo();
    const config = { ...getFullAccessConfig("codex"), cwd };
    const hidden = await ctx.client.createAgent({ config, background: true });
    const visible = await ctx.client.createAgent({ config });
    const inclusive = ctx.client.observeAgents({
      scope: "active",
      sync: {},
      includeBackground: true,
    });
    const ordinary = otherClient.observeAgents({ scope: "active", sync: {} });
    const inclusiveSnapshot = await inclusive.ready;
    const defaultSnapshot = await ordinary.ready;
    expect(inclusiveSnapshot.entries.map((entry) => entry.agent.id)).toContain(hidden.id);
    expect(defaultSnapshot.entries.map((entry) => entry.agent.id)).toEqual([visible.id]);
    const inclusiveWorkspaces = ctx.client.observeWorkspaces({ sync: {}, includeBackground: true });
    const ordinaryWorkspaces = otherClient.observeWorkspaces({ sync: {} });
    const full = await inclusiveWorkspaces.ready;
    const partial = await ordinaryWorkspaces.ready;
    expect(full.entries.map((entry) => entry.id)).toContain(hidden.workspaceId);
    expect(partial.entries.map((entry) => entry.id)).not.toContain(hidden.workspaceId);
    const received: string[] = [];
    const defaultReceived: string[] = [];
    inclusive.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "agent_update" && message.payload.kind === "upsert")
          received.push(message.payload.agent.id);
      },
    });
    ordinary.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "agent_update" && message.payload.kind === "upsert")
          defaultReceived.push(message.payload.agent.id);
      },
    });
    await ctx.client.sendAgentMessage(hidden.id, "Say done.");
    await ctx.client.waitForFinish(hidden.id, 10_000);
    await expect.poll(() => received).toContain(hidden.id);
    expect(defaultReceived).not.toContain(hidden.id);
    const catchup = await ctx.client.fetchAgents({
      scope: "active",
      includeBackground: true,
      sync: {
        generation: inclusiveSnapshot.sync?.generation,
        afterSeq: inclusiveSnapshot.sync?.headSeq,
      },
    });
    expect(catchup.sync?.mode).toBe("changes");
    expect(catchup.sync?.removals.map((item) => item.id)).not.toContain(hidden.id);
    const scopeChanged = await ctx.client.fetchAgents({
      scope: "active",
      includeBackground: true,
      sync: {
        generation: defaultSnapshot.sync?.generation,
        afterSeq: defaultSnapshot.sync?.headSeq,
      },
    });
    expect(scopeChanged.sync?.mode).toBe("snapshot");
    expect(scopeChanged.entries.map((entry) => entry.agent.id)).toContain(hidden.id);
    await inclusive.release();
    await ordinary.release();
    await inclusiveWorkspaces.release();
    await ordinaryWorkspaces.release();
  } finally {
    await otherClient.close();
  }
}, 30_000);

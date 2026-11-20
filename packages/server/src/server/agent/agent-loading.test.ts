import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reopening an agent with no resumable session keeps a metadata write that overlaps it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-handleless-metadata-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const base = createTestAgentClients().codex!;
  // A provider whose sessions leave nothing to resume (Codex before its first prompt).
  const client: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    createSession: async (config, context) => {
      const session = await base.createSession(config, context);
      session.describePersistence = () => null;
      const runtimeInfo = session.getRuntimeInfo.bind(session);
      session.getRuntimeInfo = async () => {
        const { sessionId: _sessionId, ...rest } = await runtimeInfo();
        return rest;
      };
      return session;
    },
    resumeSession: (handle, overrides, context, options) =>
      base.resumeSession(handle, overrides, context, options),
    fetchCatalog: (options) => base.fetchCatalog(options),
    isAvailable: () => base.isAvailable(),
  };
  let holdCreate: Promise<void> | null = null;
  let createEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    createEntered = resolve;
  });
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    pluginLifecycle: {
      emit: () => {},
      before: async (name, request) => {
        if (name === "agent.create.before" && holdCreate) {
          createEntered();
          await holdCreate;
        }
        return request;
      },
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000701";

  try {
    await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
      metadata: { first: 1 },
    });
    await manager.closeAgent(agentId);
    await manager.flush();
    await storage.flush();
    expect((await storage.get(agentId))?.persistence ?? null).toBeNull();

    // The reopen is held in its create hook while a plugin writes metadata to the same agent.
    let release!: () => void;
    holdCreate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reopened = ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await entered;
    const saved = manager.setMetadata(agentId, { second: 2 });
    release();

    expect(await saved).toEqual({ first: 1, second: 2 });
    await reopened;
    expect(manager.getAgent(agentId)?.metadata).toEqual({ first: 1, second: 2 });
    await manager.flush();
    await storage.flush();
    expect((await storage.get(agentId))?.metadata).toEqual({ first: 1, second: 2 });
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "loads history after its working directory is removed (archived: %s)",
  async (archived) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
    const worktree = path.join(root, "managed-worktree");
    await mkdir(worktree, { recursive: true });
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const manager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
    });

    const agentId = "00000000-0000-4000-8000-000000000501";

    try {
      const agent = await manager.createAgent({ provider: "codex", cwd: worktree }, agentId, {
        workspaceId: "workspace-worktree",
      });
      await startAgentRun(manager, agent.id, "what did you change", logger, {});
      // Dispatching a run does not finish it: the provider appends the reply to its
      // history afterwards, and the turn is finalized only once that append lands.
      // Archive after the turn is finalized so the transcript this test reads back is
      // already on disk when the worktree goes away.
      const finished = await manager.waitForAgentEvent(agent.id);
      expect(finished.status).toBe("idle");
      if (archived) await manager.archiveAgent(agent.id);
      await manager.closeAgent(agent.id);
      await manager.flush();
      await storage.flush();

      // Archiving the workspace removes the worktree it owned. The agent's history is
      // persisted and reading it must not depend on that directory still being there.
      await rm(worktree, { recursive: true, force: true });

      const loaded = await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: storage,
        logger,
        purpose: "history",
      });

      expect(loaded.id).toBe(agentId);
      // The transcript is replayed from the provider's persisted history, so the reply the
      // agent gave before the worktree went away is still readable.
      const replies = manager
        .getTimeline(agentId)
        .filter((item) => item.type === "assistant_message");
      expect(replies.length).toBeGreaterThan(0);
      expect(
        replies.every((item) => item.type === "assistant_message" && item.text.length > 0),
      ).toBe(true);
    } finally {
      await manager.closeAgent(agentId).catch(() => undefined);
      await manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("timeline requests read unarchived stored history with a deleted cwd", async () => {
  const ctx = await createDaemonTestContext();
  const cwd = await mkdtemp(path.join(tmpdir(), "timeline-deleted-cwd-"));
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    await ctx.client.sendMessage(agent.id, "remember this conversation");
    await ctx.client.waitForFinish(agent.id, 15000);
    const before = await ctx.client.fetchAgentTimeline(agent.id);
    await ctx.daemon.daemon.agentManager.closeAgent(agent.id);
    await ctx.daemon.daemon.agentManager.flush();
    await rm(cwd, { recursive: true, force: true });
    const after = await ctx.client.fetchAgentTimeline(agent.id);
    expect(after.entries).toEqual(before.entries);
    expect(after.entries.length).toBeGreaterThan(0);
    await expect(ctx.client.sendMessage(agent.id, "continue")).rejects.toThrow(
      "Working directory does not exist",
    );
    await expect(ctx.client.createAgent({ provider: "codex", cwd })).rejects.toThrow(
      "Working directory does not exist",
    );
    await mkdir(cwd);
    await ctx.client.sendMessage(agent.id, "continue after restoring directory");
    expect((await ctx.client.waitForFinish(agent.id, 15000)).status).toBe("idle");
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("timeline reads keep runnable unarchived agents interactive for the next prompt", async () => {
  const clients = createTestAgentClients();
  const base = clients.codex!;
  const purposes: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    createSession: (config, context) => base.createSession(config, context),
    resumeSession: (handle, overrides, context, options) => {
      purposes.push(options);
      return base.resumeSession(handle, overrides, context, options);
    },
    fetchCatalog: (options) => base.fetchCatalog(options),
    isAvailable: () => base.isAvailable(),
  };
  const ctx = await createDaemonTestContext({ agentClients: { codex: client } });
  const cwd = await mkdtemp(path.join(tmpdir(), "timeline-interactive-"));
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    await ctx.daemon.daemon.agentManager.closeAgent(agent.id);
    await ctx.client.fetchAgentTimeline(agent.id);
    expect(purposes).toEqual([{ purpose: "interactive" }]);
    await ctx.client.sendMessage(agent.id, "continue after opening history");
    expect((await ctx.client.waitForFinish(agent.id, 15000)).status).toBe("idle");
    const timeline = await ctx.client.fetchAgentTimeline(agent.id);
    expect(timeline.entries.length).toBeGreaterThan(0);
    await ctx.daemon.daemon.agentManager.closeAgent(agent.id);
    await rm(cwd, { recursive: true, force: true });
    await ctx.client.fetchAgentTimeline(agent.id);
    await mkdir(cwd);
    const manager = ctx.daemon.daemon.agentManager;
    await Promise.all([
      manager.tryRunOutOfBand(agent.id, "first prompt"),
      manager.tryRunOutOfBand(agent.id, "second prompt"),
    ]);
    expect(purposes).toEqual([
      { purpose: "interactive" },
      { purpose: "history" },
      undefined, // Reload uses the provider's interactive default.
    ]);
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test.each(["mode", "thinking", "rewind"])(
  "restored OMP history accepts %s before starting an interactive turn",
  async (setting) => {
    const { OmpAgentClient } = await import("./providers/omp/agent.js");
    const { FakeOmp } = await import("./providers/omp/test-utils/fake-omp.js");
    const { sendPreparedPromptToAgent } = await import("./agent-prompt.js");
    const root = await mkdtemp(path.join(tmpdir(), "history-mode-"));
    const cwd = path.join(root, "removed-worktree");
    const sessionFile = path.join(root, "session.jsonl");
    await writeFile(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "user-1",
          parentId: "root",
          message: { role: "user", content: "saved question" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const runtime = new FakeOmp();
    const manager = new AgentManager({
      clients: {
        omp: new OmpAgentClient({
          logger,
          runtime,
          runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
        }),
      },
      registry: storage,
      logger,
    });
    const agentId = "00000000-0000-4000-8000-000000000601";
    const now = new Date().toISOString();
    try {
      await storage.upsert({
        id: agentId,
        provider: "omp",
        cwd,
        createdAt: now,
        updatedAt: now,
        labels: {},
        lastStatus: "closed",
        archivedAt: null,
        persistence: {
          provider: "omp",
          sessionId: "history-mode",
          nativeHandle: sessionFile,
          metadata: { cwd },
        },
      });
      await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: storage,
        logger,
        purpose: "history",
      });
      expect(
        runtime.recordedLaunches.filter((launch) => launch.session === sessionFile),
      ).toHaveLength(0);
      await mkdir(cwd);
      if (setting === "rewind") {
        await manager.rewind(agentId, "user-1", "conversation");
        expect(runtime.latestSession().branchRequests).toEqual(["user-1"]);
      }
      if (setting === "thinking") {
        await manager.setAgentThinkingOption(agentId, "high");
        expect(manager.getAgent(agentId)?.config.thinkingOptionId).toBe("high");
        expect(runtime.latestSession().setThinkingLevelRequests).toContain("high");
      }
      await sendPreparedPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId,
        logger,
        prompt: "continue",
        sessionMode: "full",
      });
      expect(
        runtime.recordedLaunches.filter((launch) => launch.session === sessionFile),
      ).toHaveLength(1);
      expect(manager.getAgent(agentId)?.currentModeId).toBe("full");
      expect(runtime.latestSession().prompts).toEqual([
        expect.objectContaining({ message: "continue" }),
      ]);
      runtime.latestSession().finishTurn();
      await manager.waitForAgentEvent(agentId);
      await manager.archiveAgent(agentId);
      await manager.closeAgent(agentId);
      await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
      const launchesBeforeModeChange = runtime.recordedLaunches.length;
      await expect(manager.setAgentMode(agentId, "full")).rejects.toThrow("Agent is archived");
      expect(runtime.recordedLaunches).toHaveLength(launchesBeforeModeChange);
    } finally {
      await manager.closeAgent(agentId).catch(() => undefined);
      await manager.flush();
      await storage.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

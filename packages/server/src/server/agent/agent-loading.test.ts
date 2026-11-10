import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { AgentNotFoundError, ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentHistoryReadContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function completeHistory(events: AgentStreamEvent[]) {
  return { events, coverage: { kind: "complete" as const } };
}

type HistoryReader = NonNullable<AgentClient["readSessionHistory"]>;

interface LoaderHarnessOptions {
  readSessionHistory?: HistoryReader;
  archiveNativeSession?: (handle: AgentPersistenceHandle) => Promise<void>;
  unarchiveNativeSession?: (handle: AgentPersistenceHandle) => Promise<void>;
}

async function createLoaderHarness(options: LoaderHarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-history-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const calls = {
    createCount: 0,
    resumeSessionIds: [] as string[],
    history: [] as Array<{
      handle: AgentPersistenceHandle;
      context: AgentHistoryReadContext | undefined;
    }>,
  };
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) => {
      calls.createCount += 1;
      return await baseClient.createSession(config, launchContext);
    },
    resumeSession: async (handle, overrides, launchContext) => {
      calls.resumeSessionIds.push(handle.sessionId);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    readSessionHistory: async (handle, context) => {
      calls.history.push({ handle, context });
      return (await options.readSessionHistory?.(handle, context)) ?? completeHistory([]);
    },
    archiveNativeSession: options.archiveNativeSession,
    unarchiveNativeSession: options.unarchiveNativeSession,
    fetchCatalog: async (catalogOptions) => await baseClient.fetchCatalog(catalogOptions),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  onTestFinished(async () => {
    for (const agent of manager.listAgents()) {
      await manager.closeAgent(agent.id).catch(() => undefined);
    }
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    logger,
    storage,
    manager,
    calls,
    requireRecord: async (agentId: string) => {
      const record = await storage.get(agentId);
      if (!record) {
        throw new Error(`expected a stored record for ${agentId}`);
      }
      return record;
    },
    load: async (agentId: string, broadcastTimeline = false) =>
      await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: storage,
        ...(broadcastTimeline ? { broadcastTimeline: true } : {}),
        logger,
      }),
    seedArchivedInternal: async (agentId: string) => {
      // Internal runtimes are disposable; only legacy records retain their history on disk.
      await storage.upsert({
        id: agentId,
        provider: "codex",
        cwd: root,
        workspaceId: "workspace-archived",
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:01.000Z",
        labels: {},
        lastStatus: "closed",
        internal: true,
        archivedAt: "2026-08-22T00:00:01.000Z",
        persistence: {
          provider: "codex",
          sessionId: `legacy-internal-${agentId}`,
          metadata: { cwd: root },
        },
      });
    },
    createArchived: async (agentId: string) => {
      const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
        workspaceId: "workspace-archived",
      });
      await manager.archiveAgent(agent.id);
      return agent;
    },
  };
}

test("loads archived history without interactive resume or archive-state changes", async () => {
  let nativeArchived = false;
  let nativeUnarchiveCount = 0;
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      expect(nativeArchived).toBe(true);
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "Archived provider history" },
        },
      ]);
    },
    archiveNativeSession: async () => {
      nativeArchived = true;
    },
    unarchiveNativeSession: async () => {
      nativeArchived = false;
      nativeUnarchiveCount += 1;
    },
  });
  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";
  const archived = await harness.createArchived(archivedId);
  const archivedAt = (await harness.storage.get(archived.id))?.archivedAt;
  const active = await harness.manager.createAgent(
    { provider: "codex", cwd: harness.root },
    activeId,
    { workspaceId: "workspace-active" },
  );
  await harness.manager.closeAgent(active.id);

  const archivedSnapshot = await harness.load(archived.id);
  const activeSnapshot = await harness.load(active.id);

  expect(archivedSnapshot.lifecycle).toBe("closed");
  expect(activeSnapshot.lifecycle).toBe("idle");
  expect(harness.manager.getAgent(archived.id)).toBeNull();
  expect(harness.manager.getTimeline(archived.id)).toContainEqual({
    type: "assistant_message",
    text: "Archived provider history",
  });
  expect(harness.calls.history).toEqual([
    {
      handle: expect.objectContaining({ sessionId: archived.persistence?.sessionId }),
      context: { agentId: archived.id, cwd: harness.root },
    },
  ]);
  expect(harness.calls.resumeSessionIds).toEqual([active.persistence?.sessionId]);
  expect((await harness.storage.get(archived.id))?.archivedAt).toBe(archivedAt);
  expect(nativeArchived).toBe(true);
  expect(nativeUnarchiveCount).toBe(0);
});

test("keeps archived internal history hidden from public provider-subagent reads", async () => {
  const agentId = "00000000-0000-4000-8000-000000000307";
  const subagentId = "hidden-archived-child";
  const harness = await createLoaderHarness({
    readSessionHistory: async () =>
      completeHistory([
        {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "upsert",
            id: subagentId,
            title: "Hidden archived child",
            status: "completed",
          },
        },
      ]),
  });
  await harness.seedArchivedInternal(agentId);
  expect((await harness.storage.get(agentId))?.internal).toBe(true);

  const snapshot = await harness.load(agentId);

  expect(snapshot.internal).toBe(true);
  expect(() => harness.manager.getTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  expect(() => harness.manager.fetchPublicTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  expect(() => harness.manager.listProviderSubagents(agentId)).toThrow(
    `Unknown agent '${agentId}'`,
  );
  expect(() => harness.manager.getProviderSubagent(agentId, subagentId)).toThrow(
    `Unknown agent '${agentId}'`,
  );
  expect(() => harness.manager.fetchProviderSubagentTimeline(agentId, subagentId)).toThrow(
    `Unknown agent '${agentId}'`,
  );
});

test("shares archived history reads and upgrades deferred timeline broadcast", async () => {
  const historyStarted = deferred();
  const historyAllowed = deferred();
  onTestFinished(() => historyAllowed.resolve());
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      historyStarted.resolve();
      await historyAllowed.promise;
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "Shared archived history" },
        },
      ]);
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000303";
  await harness.createArchived(agentId);
  const events: AgentManagerEvent[] = [];
  harness.manager.subscribe((event) => events.push(event), { agentId, replayState: false });

  const quietLoad = harness.load(agentId);
  await historyStarted.promise;
  const broadcastingLoad = harness.load(agentId, true);
  historyAllowed.resolve();

  const [quietSnapshot, broadcastingSnapshot] = await Promise.all([quietLoad, broadcastingLoad]);
  const cachedSnapshot = await harness.load(agentId);
  expect([quietSnapshot.id, broadcastingSnapshot.id, cachedSnapshot.id]).toEqual([
    agentId,
    agentId,
    agentId,
  ]);
  expect(harness.calls.history).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent_stream",
      agentId,
      event: expect.objectContaining({
        type: "timeline",
        item: { type: "assistant_message", text: "Shared archived history" },
      }),
    }),
  );
});

async function runConcurrentUnarchiveScenario(
  historyFails: boolean,
  scenarioOptions?: { internal?: boolean },
) {
  const historyStarted = deferred();
  const historyAllowed = deferred();
  onTestFinished(() => historyAllowed.resolve());
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      historyStarted.resolve();
      await historyAllowed.promise;
      if (historyFails) {
        throw new Error("archived history became unavailable");
      }
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "History before unarchive" },
        },
      ]);
    },
    archiveNativeSession: async () => undefined,
    unarchiveNativeSession: async () => undefined,
  });
  let agentId = "00000000-0000-4000-8000-000000000304";
  if (historyFails) {
    agentId = "00000000-0000-4000-8000-000000000305";
  }
  if (scenarioOptions?.internal) {
    agentId = "00000000-0000-4000-8000-000000000308";
  }
  if (scenarioOptions?.internal) {
    await harness.seedArchivedInternal(agentId);
  } else {
    await harness.createArchived(agentId);
  }
  const attentionTimestamp = "2026-08-22T03:04:05.000Z";
  const archivedRecord = await harness.requireRecord(agentId);
  await harness.storage.upsert({
    ...archivedRecord,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp,
  });

  const archivedLoad = harness.load(agentId);
  await historyStarted.promise;
  await harness.manager.unarchiveSnapshot(agentId);
  const interactiveLoad = harness.load(agentId);
  historyAllowed.resolve();
  const [first, second] = await Promise.all([archivedLoad, interactiveLoad]);

  expect(first.lifecycle).toBe("idle");
  expect(second.lifecycle).toBe("idle");
  expect(harness.manager.getAgent(agentId)?.lifecycle).toBe("idle");
  expect(harness.calls.history).toHaveLength(1);
  expect(harness.calls.resumeSessionIds).toHaveLength(1);
  const expectedAttention = {
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date(attentionTimestamp),
  };
  expect(first.attention).toEqual(expectedAttention);
  expect(second.attention).toEqual(expectedAttention);
  expect(harness.manager.getAgent(agentId)?.attention).toEqual(expectedAttention);
  await harness.manager.flush();
  await harness.storage.flush();
  expect(await harness.requireRecord(agentId)).toMatchObject({
    archivedAt: null,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp,
  });
  return { harness, agentId };
}

test("promotes a shared archived history read to interactive resume after unarchive", async () => {
  const { harness, agentId } = await runConcurrentUnarchiveScenario(false);
  expect(harness.manager.getTimeline(agentId)).toContainEqual({
    type: "assistant_message",
    text: "History before unarchive",
  });
});

test("promotes to interactive resume when archived history fails after unarchive", async () => {
  await runConcurrentUnarchiveScenario(true);
});

test("serves read-only history when an archive wins the lifecycle lane before a queued resume", async () => {
  const harness = await createLoaderHarness({
    readSessionHistory: async () =>
      completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "History after a queued archive" },
        },
      ]),
  });
  const agentId = "00000000-0000-4000-8000-000000000311";
  const agent = await harness.manager.createAgent(
    { provider: "codex", cwd: harness.root },
    agentId,
    { workspaceId: "workspace-active" },
  );
  await harness.manager.closeAgent(agent.id);
  // The loader reads the record before the archive lands, so it still chooses resume.
  let archived = false;
  const staleStorage = new Proxy(harness.storage, {
    get(target, property) {
      if (property === "get") {
        return async (id: string) => {
          const record = await target.get(id);
          if (!archived) {
            archived = true;
            await harness.manager.archiveSnapshot(id, new Date().toISOString());
          }
          return record;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const snapshot = await ensureAgentLoaded(agentId, {
    agentManager: harness.manager,
    agentStorage: staleStorage,
    logger: harness.logger,
  });

  expect(snapshot.lifecycle).toBe("closed");
  expect(harness.calls.resumeSessionIds).toEqual([]);
  expect(harness.calls.history).toHaveLength(1);
  expect(harness.manager.getAgent(agentId)).toBeNull();
  expect(harness.manager.getTimeline(agentId)).toContainEqual({
    type: "assistant_message",
    text: "History after a queued archive",
  });
  expect((await harness.storage.get(agentId))?.archivedAt).toEqual(expect.any(String));
});

test("does not retain archived history state when the provider read fails", async () => {
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      throw new Error("archived history is unavailable");
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000309";
  await harness.createArchived(agentId);

  await expect(harness.load(agentId)).rejects.toThrow("archived history is unavailable");

  expect(harness.manager.getHistorySnapshot(agentId)).toBeNull();
  expect(() => harness.manager.fetchTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  expect(harness.manager.getAgent(agentId)).toBeNull();
});

test("discards archived history state when the record is deleted during the read", async () => {
  const historyStarted = deferred();
  const historyAllowed = deferred();
  onTestFinished(() => historyAllowed.resolve());
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      historyStarted.resolve();
      await historyAllowed.promise;
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "History deleted during read" },
        },
      ]);
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000310";
  await harness.createArchived(agentId);

  const load = harness.load(agentId);
  await historyStarted.promise;
  await harness.storage.remove(agentId);
  await harness.manager.deleteAgentState(agentId);
  historyAllowed.resolve();

  await expect(load).rejects.toThrow(AgentNotFoundError);
  expect(harness.manager.getHistorySnapshot(agentId)).toBeNull();
  expect(harness.manager.getAgent(agentId)).toBeNull();
  expect(() => harness.manager.fetchTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  await expect(harness.load(agentId)).rejects.toThrow(`Agent not found: ${agentId}`);
});

test("preserves internal visibility when archived history is promoted after unarchive", async () => {
  const { harness, agentId } = await runConcurrentUnarchiveScenario(false, { internal: true });

  expect(harness.manager.getAgent(agentId)?.internal).toBe(true);
  expect(harness.manager.listAgents().map((agent) => agent.id)).not.toContain(agentId);

  await harness.manager.closeAgent(agentId);
});

test("does not create an interactive session for an archived record without persistence", async () => {
  const harness = await createLoaderHarness({ archiveNativeSession: async () => undefined });
  const agentId = "00000000-0000-4000-8000-000000000306";
  await harness.createArchived(agentId);
  const archivedRecord = await harness.requireRecord(agentId);
  await harness.storage.upsert({ ...archivedRecord, persistence: undefined });
  const createCountBeforeLoad = harness.calls.createCount;

  await expect(harness.load(agentId)).rejects.toThrow(
    `Archived agent history is unavailable without persistence: ${agentId}`,
  );
  expect(harness.calls.createCount).toBe(createCountBeforeLoad);
  expect(harness.calls.resumeSessionIds).toEqual([]);
  expect(harness.calls.history).toEqual([]);
  expect(harness.manager.getAgent(agentId)).toBeNull();
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
    readSessionHistory: (handle, context) => base.readSessionHistory!(handle, context),
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
    expect(purposes).toEqual([{ purpose: "interactive" }, { purpose: "interactive" }]);
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
      await manager.markAgentUnread(agentId);
      await manager.updateAgentMetadata(agentId, { labels: { changedAfterRead: "yes" } });
      const latestRecord = await storage.get(agentId);
      await mkdir(cwd);
      if (setting === "mode") await manager.setAgentMode(agentId, "full");
      if (setting === "rewind") {
        await manager.rewind(agentId, "user-1", "conversation");
        expect(runtime.latestSession().branchRequests).toEqual(["user-1"]);
      }
      if (setting === "thinking") {
        await manager.setAgentThinkingOption(agentId, "high");
        expect(manager.getAgent(agentId)?.config.thinkingOptionId).toBe("high");
        expect(runtime.latestSession().setThinkingLevelRequests).toContain("high");
      }
      const interactive = manager.getAgent(agentId);
      expect(interactive?.labels).toEqual({ changedAfterRead: "yes" });
      expect(interactive?.attention).toEqual({
        requiresAttention: true,
        attentionReason: latestRecord?.attentionReason,
        attentionTimestamp: new Date(latestRecord!.attentionTimestamp!),
      });
      expect(interactive!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        Date.parse(latestRecord!.updatedAt),
      );
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

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import type {
  AgentClient,
  AgentHistoryLoader,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { OmpAgentClient } from "./providers/omp/agent.js";
import { FakeOmp } from "./providers/omp/test-utils/fake-omp.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("loads archived history after its cwd is removed and active records interactively", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const archivedCwd = path.join(root, "archived-workspace");
  const activeCwd = path.join(root, "active-workspace");
  await Promise.all([mkdir(archivedCwd), mkdir(activeCwd)]);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const historyLoads: AgentPersistenceHandle[] = [];
  const interactiveResumes: AgentPersistenceHandle[] = [];
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
    ): Promise<AgentSession> => {
      interactiveResumes.push(handle);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    loadHistorySession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
    ): Promise<AgentHistoryLoader> => {
      historyLoads.push(handle);
      const session = await baseClient.resumeSession(handle, overrides);
      session.streamHistory = async function* () {
        yield {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "persisted response" },
        } satisfies AgentStreamEvent;
      };
      return session;
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
    const archived = await manager.createAgent(
      { provider: "codex", cwd: archivedCwd },
      archivedId,
      {
        workspaceId: "workspace-archived",
      },
    );
    await manager.archiveAgent(archived.id);
    await rm(archivedCwd, { recursive: true, force: true });
    await manager.flush();
    await storage.flush();
    const archivedRecordBeforeHistoryLoad = await storage.get(archived.id);
    if (!archivedRecordBeforeHistoryLoad) {
      throw new Error("expected archived record before history load");
    }
    const attentionTimestamp = new Date("2025-01-15T00:00:00.000Z").toISOString();
    const archivedRecordWithAttention: StoredAgentRecord = {
      ...archivedRecordBeforeHistoryLoad,
      requiresAttention: true,
      attentionReason: "permission",
      attentionTimestamp,
    };
    await storage.upsert(archivedRecordWithAttention);

    const active = await manager.createAgent({ provider: "codex", cwd: activeCwd }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(historyLoads.map((handle) => handle.sessionId)).toEqual([
      archived.persistence?.sessionId,
    ]);
    expect(interactiveResumes.map((handle) => handle.sessionId)).toEqual([
      active.persistence?.sessionId,
    ]);
    expect(manager.getAgent(archived.id)?.sessionExecutionMode).toBe("history-only");
    expect(manager.getAgent(active.id)?.sessionExecutionMode).toBe("interactive");
    expect(manager.getAgent(archived.id)?.attention).toEqual({
      requiresAttention: true,
      attentionReason: "permission",
      attentionTimestamp: new Date(attentionTimestamp),
    });
    expect(() => manager.streamAgent(archived.id, "must not run")).toThrow(
      `Agent '${archived.id}' is loaded for history only`,
    );
    expect(manager.fetchTimeline(archived.id, { limit: 0 }).rows).toEqual([
      expect.objectContaining({
        item: { type: "assistant_message", text: "persisted response" },
      }),
    ]);
    await manager.flush();
    await storage.flush();
    expect(await storage.get(archived.id)).toEqual(archivedRecordWithAttention);

    await manager.clearAgentAttention(archived.id);
    expect(manager.getAgent(archived.id)?.attention).toEqual({ requiresAttention: false });
    expect(await storage.get(archived.id)).toMatchObject({
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    });
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

test("rejects interactive resume after its cwd is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }
  const manager = new AgentManager({
    clients: { codex: baseClient },
    registry: storage,
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000303";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd }, agentId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(agent.id);
    await rm(cwd, { recursive: true, force: true });

    await expect(
      ensureAgentLoaded(agent.id, { agentManager: manager, agentStorage: storage, logger }),
    ).rejects.toThrow(`Working directory does not exist: ${cwd}`);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for archived records without persisted history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-no-history-"));
  const cwd = path.join(root, "removed-workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const client = createTestAgentClients().codex;
  if (!client) {
    throw new Error("expected Codex test client");
  }
  const createSession = vi.spyOn(client, "createSession");
  const fetchCatalog = vi.spyOn(client, "fetchCatalog");
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000307";
  const now = new Date().toISOString();

  try {
    await storage.upsert({
      id: agentId,
      provider: "codex",
      cwd,
      createdAt: now,
      updatedAt: now,
      labels: {},
      lastStatus: "closed",
      config: null,
      persistence: null,
      archivedAt: now,
    });
    await rm(cwd, { recursive: true, force: true });

    await expect(
      ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger }),
    ).rejects.toThrow(`Archived agent ${agentId} has no persisted session history`);

    expect(createSession).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed before provider resume when history loading is unsupported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-unsupported-history-"));
  const cwd = path.join(root, "removed-workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }
  const resumeSession = vi.fn(baseClient.resumeSession.bind(baseClient));
  const fetchCatalog = vi.fn(baseClient.fetchCatalog.bind(baseClient));
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: baseClient.createSession.bind(baseClient),
    resumeSession,
    fetchCatalog,
    isAvailable: baseClient.isAvailable.bind(baseClient),
  };
  const manager = new AgentManager({ clients: { codex: client }, logger });
  const agentId = "00000000-0000-4000-8000-000000000308";
  await rm(cwd, { recursive: true, force: true });

  try {
    await expect(
      manager.loadAgentHistoryFromPersistence(
        {
          provider: "codex",
          sessionId: "unsupported-history-session",
          metadata: { cwd },
        },
        undefined,
        agentId,
      ),
    ).rejects.toThrow("Provider 'codex' does not support non-runnable history loading");

    expect(resumeSession).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
  } finally {
    await manager.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads archived OMP history without catalog discovery or a runtime launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-omp-history-"));
  const cwd = path.join(root, "removed-workspace");
  const sessionFile = path.join(root, "omp-session.jsonl");
  await mkdir(cwd);
  await writeFile(
    sessionFile,
    [
      { type: "session", id: "session-root", parentId: null },
      {
        type: "message",
        id: "user-1",
        parentId: "session-root",
        message: { role: "user", content: "persisted question" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "persisted answer" }],
          responseId: "assistant-1",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "utf8",
  );

  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const runtime = new FakeOmp();
  const client = new OmpAgentClient({ logger, runtime });
  const fetchCatalog = vi.spyOn(client, "fetchCatalog");
  const manager = new AgentManager({ clients: { omp: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000304";
  const now = new Date().toISOString();
  const record = {
    id: agentId,
    provider: "omp",
    cwd,
    createdAt: now,
    updatedAt: now,
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: {
      provider: "omp",
      sessionId: "omp-session-1",
      nativeHandle: sessionFile,
      metadata: { cwd },
    },
    archivedAt: now,
  } satisfies StoredAgentRecord;

  try {
    await storage.upsert(record);
    await rm(cwd, { recursive: true, force: true });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.sessionExecutionMode).toBe("history-only");
    expect(loaded.config.model).toBeUndefined();
    expect(loaded.config.modeId).toBeUndefined();
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(runtime.recordedLaunches).toHaveLength(0);
    expect(manager.fetchTimeline(agentId, { limit: 0 }).rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "persisted question", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "persisted answer",
        messageId: "assistant-1",
      },
    ]);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("unarchive send closes and replaces a history-only loader before starting a turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-unarchive-replace-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const actions: string[] = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) =>
      await baseClient.createSession(config, launchContext),
    resumeSession: async (handle, overrides, launchContext) => {
      actions.push("interactive-resume");
      const session = await baseClient.resumeSession(handle, overrides, launchContext);
      const startTurn = session.startTurn.bind(session);
      session.startTurn = async (prompt, options) => {
        actions.push("interactive-start");
        return await startTurn(prompt, options);
      };
      return session;
    },
    loadHistorySession: async (handle) => ({
      provider: "codex",
      id: handle.sessionId,
      capabilities: baseClient.capabilities,
      streamHistory: async function* () {},
      describePersistence: () => handle,
      close: async () => {
        actions.push("history-close");
      },
    }),
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
    unarchiveNativeSession: async () => {
      actions.push("native-unarchive");
    },
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000305";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd }, agentId, {
      workspaceId: "workspace-unarchive",
    });
    await manager.archiveAgent(agent.id);
    await ensureAgentLoaded(agent.id, { agentManager: manager, agentStorage: storage, logger });

    await sendPromptToAgent({
      agentManager: manager,
      agentStorage: storage,
      agentId: agent.id,
      prompt: "continue",
      logger,
    });
    await vi.waitFor(() => expect(actions).toContain("interactive-start"));

    expect(actions.slice(0, 4)).toEqual([
      "history-close",
      "native-unarchive",
      "interactive-resume",
      "interactive-start",
    ]);
    expect(manager.getAgent(agent.id)?.sessionExecutionMode).toBe("interactive");
    expect((await storage.get(agent.id))?.archivedAt).toBeNull();
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("three concurrent loaders converge on one interactive session across unarchive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-unarchive-single-flight-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const historyStarted = deferred<void>();
  const historyAllowed = deferred<void>();
  const actions: string[] = [];
  let historyLoadCount = 0;
  let interactiveResumeCount = 0;
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: baseClient.createSession.bind(baseClient),
    resumeSession: async (handle, overrides, launchContext) => {
      interactiveResumeCount += 1;
      actions.push("interactive-resume");
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    loadHistorySession: async (handle) => {
      historyLoadCount += 1;
      actions.push("history-load");
      return {
        provider: "codex",
        id: handle.sessionId,
        capabilities: baseClient.capabilities,
        streamHistory: async function* () {
          historyStarted.resolve();
          await historyAllowed.promise;
          yield {
            type: "timeline",
            provider: "codex",
            item: { type: "assistant_message", text: "persisted response" },
          } satisfies AgentStreamEvent;
        },
        describePersistence: () => handle,
        close: async () => {
          actions.push("history-close");
        },
      };
    },
    fetchCatalog: baseClient.fetchCatalog.bind(baseClient),
    isAvailable: baseClient.isAvailable.bind(baseClient),
    unarchiveNativeSession: async () => {
      actions.push("native-unarchive");
    },
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000310";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd }, agentId, {
      workspaceId: "workspace-unarchive-single-flight",
    });
    await manager.archiveAgent(agent.id);

    const firstLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await historyStarted.promise;
    const secondLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    const thirdLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const unarchive = manager.unarchiveSnapshot(agent.id);
    historyAllowed.resolve();
    const [first, second, third, didUnarchive] = await Promise.all([
      firstLoad,
      secondLoad,
      thirdLoad,
      unarchive,
    ]);

    expect(didUnarchive).toBe(true);
    expect([first, second, third].map((snapshot) => snapshot.sessionExecutionMode)).toEqual([
      "interactive",
      "interactive",
      "interactive",
    ]);
    const sessions = [first, second, third].map((snapshot) =>
      snapshot.lifecycle === "closed" ? null : snapshot.session,
    );
    expect(new Set(sessions).size).toBe(1);
    const current = manager.getAgent(agent.id);
    expect(current?.sessionExecutionMode).toBe("interactive");
    expect(sessions[0]).toBe(current?.lifecycle === "closed" ? null : current?.session);
    expect(historyLoadCount).toBe(1);
    expect(interactiveResumeCount).toBe(1);
    expect(actions).toEqual([
      "history-load",
      "history-close",
      "native-unarchive",
      "interactive-resume",
    ]);
  } finally {
    historyAllowed.resolve();
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("unarchive send validates cwd before native unarchive or interactive resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-unarchive-cwd-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const interactiveResume = vi.fn(baseClient.resumeSession.bind(baseClient));
  const nativeUnarchive = vi.fn(async () => {});
  const historyClose = vi.fn(async () => {});
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) =>
      await baseClient.createSession(config, launchContext),
    resumeSession: interactiveResume,
    loadHistorySession: async (handle) => ({
      provider: "codex",
      id: handle.sessionId,
      capabilities: baseClient.capabilities,
      streamHistory: async function* () {},
      describePersistence: () => handle,
      close: historyClose,
    }),
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
    unarchiveNativeSession: nativeUnarchive,
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000306";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd }, agentId, {
      workspaceId: "workspace-unarchive",
    });
    await manager.archiveAgent(agent.id);
    await ensureAgentLoaded(agent.id, { agentManager: manager, agentStorage: storage, logger });
    await rm(cwd, { recursive: true, force: true });

    await expect(
      sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: agent.id,
        prompt: "continue",
        logger,
      }),
    ).rejects.toThrow(`Working directory does not exist: ${cwd}`);

    expect(nativeUnarchive).not.toHaveBeenCalled();
    expect(interactiveResume).not.toHaveBeenCalled();
    expect(historyClose).not.toHaveBeenCalled();
    expect(manager.getAgent(agent.id)?.sessionExecutionMode).toBe("history-only");
    expect((await storage.get(agent.id))?.archivedAt).not.toBeNull();
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

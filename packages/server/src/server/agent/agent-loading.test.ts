import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { AgentConfigSession } from "../session/agent-config/agent-config-session.js";
import { toAgentPayload } from "./agent-projections.js";

test("completion provenance survives storage reload and is cleared before a later failed turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-completion-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
  let id: string | undefined;
  try {
    const agent = await manager.createAgent(
      { provider: "codex", cwd: root, modeId: "full-access" },
      undefined,
      { workspaceId: undefined },
    );
    id = agent.id;
    await manager.runAgent(id, "Respond with exactly: Completed");
    const completed = manager.getAgent(id)!;
    expect(completed.lastCompletedTurnId).toBeDefined();
    expect(toAgentPayload(completed).lastCompletedTurnId).toBe(completed.lastCompletedTurnId);
    await manager.closeAgent(id);
    expect((await storage.get(id))?.lastCompletedTurnId).toBe(completed.lastCompletedTurnId);
    const loaded = await ensureAgentLoaded(id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    expect(loaded.lastCompletedTurnId).toBe(completed.lastCompletedTurnId);
    await expect(manager.runAgent(id, "Emit a turn failure")).rejects.toThrow(
      "Requested fake provider failure",
    );
    expect(manager.getAgent(id)?.lastCompletedTurnId).toBeUndefined();
    await manager.flush();
    expect((await storage.get(id))?.lastCompletedTurnId).toBeUndefined();
  } finally {
    if (id) await manager.closeAgent(id);
    await manager.flush();
    await rm(root, { recursive: true, force: true });
  }
});

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
  const hookRequests: unknown[] = [];
  const hookEvents: unknown[] = [];
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    pluginLifecycle: {
      before: async (name, request) => {
        if (name === "agent.create") hookRequests.push(request);
        return request;
      },
      emit: (name, event) => {
        if (name === "agent.created") hookEvents.push(event);
      },
    },
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
      launchProfileId: "planner",
    });
    expect(active.launchProfileId).toBe("planner");
    expect(hookRequests[1]).toMatchObject({
      workspaceId: "workspace-active",
      launchProfileId: "planner",
    });
    expect(hookEvents[1]).toMatchObject({ agent: { id: active.id, launchProfileId: "planner" } });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
    expect(manager.getAgent(active.id)?.launchProfileId).toBe("planner");
    const reloaded = await manager.reloadAgentSession(active.id, { model: "gpt-5.4" });
    expect(reloaded.launchProfileId).toBe("planner");
    expect(reloaded.config.model).toBe("gpt-5.4");
    expect(reloaded.config).not.toHaveProperty("launchProfileId");
    const configSession = new AgentConfigSession({
      logger,
      host: { emit: (message) => expect(message).toMatchObject({ payload: { accepted: true } }) },
      operations: {
        ensureLoaded: async (id) => {
          await ensureAgentLoaded(id, { agentManager: manager, agentStorage: storage, logger });
        },
        setModel: (id, model) => manager.setAgentModel(id, model),
        setMode: (id, mode) => manager.setAgentMode(id, mode),
        setThinking: (id, thinking) => manager.setAgentThinkingOption(id, thinking),
        setFeature: (id, feature, value) => manager.setAgentFeature(id, feature, value),
      },
    });
    await configSession.handleAgentConfigApplyRequest({
      type: "agent.config.apply.request",
      agentId: active.id,
      requestId: "apply-other-profile",
      config: { modelId: "gpt-5.3-codex" },
    });
    expect(manager.getAgent(active.id)?.config.model).toBe("gpt-5.3-codex");
    expect(manager.getAgent(active.id)?.launchProfileId).toBe("planner");
    await manager.closeAgent(active.id);
    const stored = await storage.get(active.id);
    expect(stored?.launchProfileId).toBe("planner");
    if (!stored) throw new Error("Expected durable agent record");
    await storage.upsert({ ...stored, persistence: null });
    const recreated = await ensureAgentLoaded(active.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    expect(recreated.launchProfileId).toBe("planner");
    expect(recreated.config.model).toBe("gpt-5.3-codex");
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

test("loads an archived agent's history after its working directory is removed", async () => {
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
    await manager.archiveAgent(agent.id);
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
    });

    expect(loaded.id).toBe(agentId);
    // The transcript is replayed from the provider's persisted history, so the reply the
    // agent gave before the worktree went away is still readable.
    const replies = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((item) => item.type === "assistant_message" && item.text.length > 0)).toBe(
      true,
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

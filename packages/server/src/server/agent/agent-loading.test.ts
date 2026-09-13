import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
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

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
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

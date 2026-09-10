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

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const launchContexts: AgentLaunchContext[] = [];
  const resolvedWorkspaceIds: string[] = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => {
      launchContexts.push(launchContext ?? {});
      return await baseClient.createSession(config, launchContext);
    },
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      launchContexts.push(launchContext ?? {});
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    resolveWorkspaceProjectResourceApproval: async (workspaceId) => {
      resolvedWorkspaceIds.push(workspaceId);
      return workspaceId === "workspace-active";
    },
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

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
    expect(resolvedWorkspaceIds).toEqual(["workspace-active"]);
    expect(launchContexts[2]?.approveProjectResources).toBeUndefined();
    expect(launchContexts[3]?.approveProjectResources).toBe(true);
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

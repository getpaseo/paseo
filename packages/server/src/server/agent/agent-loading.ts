import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "ensureAgentInitialized"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  return deps.agentManager.ensureAgentInitialized(agentId, {
    broadcastTimeline: deps.broadcastTimeline,
    initialize: async (historyBroadcast) => {
      const record = await deps.agentStorage.get(agentId);
      if (!record) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
      if (!isStoredAgentProviderAvailable(record, validProviders)) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }

      const handle = toAgentPersistenceHandle(validProviders, record.persistence);

      let snapshot: ManagedAgent;
      if (handle) {
        snapshot = await deps.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          {
            ...extractTimestamps(record),
            historyBroadcast,
          },
          record.archivedAt ? { purpose: "history" } : undefined,
        );
        deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
      } else {
        const config = buildSessionConfig(record, {
          validProviders,
        });
        if (!config) {
          throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
        }
        snapshot = await deps.agentManager.createAgent(config, agentId, {
          labels: record.labels,
          workspaceId: record.workspaceId,
          owner: record.owner,
        });
        deps.logger.info(
          { agentId, provider: record.provider },
          "Agent created from stored config",
        );
      }

      if (!handle) {
        await deps.agentManager.hydrateTimelineFromProvider(agentId, {
          broadcast: historyBroadcast,
        });
      }
      return deps.agentManager.getAgent(agentId) ?? snapshot;
    },
  });
}

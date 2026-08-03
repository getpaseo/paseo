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
import {
  claimPendingAgentInitialization,
  clearPendingAgentInitialization,
  getPendingAgentInitialization,
  hasAgentInteractiveTransition,
  type PendingAgentInitialization,
  waitForAgentInteractiveTransition,
} from "./agent-load-coordinator.js";

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "closeAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "loadAgentHistoryFromPersistence"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
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
  while (true) {
    await waitForAgentInteractiveTransition(agentId);
    await deps.agentManager.waitForAgentClose?.(agentId);

    const inflight = getPendingAgentInitialization(agentId);
    if (inflight) {
      inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
      await inflight.promise;
      continue;
    }

    const existing = deps.agentManager.getAgent(agentId);
    if (existing) {
      const reusable = await reuseLoadedAgent(existing, agentId, deps);
      if (reusable) {
        await waitForAgentInteractiveTransition(agentId);
        if (hasAgentInteractiveTransition(agentId)) {
          continue;
        }
        const current = deps.agentManager.getAgent(agentId);
        if (current) {
          return current;
        }
      }
      continue;
    }

    // A close or transition may have started after the first barriers. Claim
    // initialization only after checking both again, then let every caller
    // converge through the claimed promise and the current manager snapshot.
    await deps.agentManager.waitForAgentClose?.(agentId);
    await waitForAgentInteractiveTransition(agentId);
    if (getPendingAgentInitialization(agentId) || deps.agentManager.getAgent(agentId)) {
      continue;
    }

    let resolveInitialization!: (agent: ManagedAgent) => void;
    let rejectInitialization!: (error: unknown) => void;
    const promise = new Promise<ManagedAgent>((resolve, reject) => {
      resolveInitialization = resolve;
      rejectInitialization = reject;
    });
    const pending: PendingAgentInitialization = {
      promise,
      options: { broadcastTimeline: deps.broadcastTimeline === true },
    };
    if (!claimPendingAgentInitialization(agentId, pending)) {
      continue;
    }

    try {
      resolveInitialization(await initializeAgent(agentId, deps, pending));
      await promise;
    } catch (error) {
      rejectInitialization(error);
      await promise.catch(() => undefined);
      throw error;
    } finally {
      clearPendingAgentInitialization(agentId, pending);
    }
  }
}

async function initializeAgent(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
  pending: PendingAgentInitialization,
): Promise<ManagedAgent> {
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
  if (record.archivedAt) {
    if (!handle) {
      throw new Error(`Archived agent ${agentId} has no persisted session history`);
    }
    snapshot = await deps.agentManager.loadAgentHistoryFromPersistence(
      handle,
      buildConfigOverrides(record),
      agentId,
      extractTimestamps(record),
    );
    deps.logger.info(
      { agentId, provider: record.provider },
      "Agent history loaded from persistence",
    );
  } else if (handle) {
    snapshot = await deps.agentManager.resumeAgentFromPersistence(
      handle,
      buildConfigOverrides(record),
      agentId,
      extractTimestamps(record),
    );
    deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
  } else {
    const config = buildSessionConfig(record, { validProviders });
    if (!config) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }
    snapshot = await deps.agentManager.createAgent(config, agentId, {
      labels: record.labels,
      workspaceId: record.workspaceId,
      owner: record.owner,
    });
    deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
  }

  await deps.agentManager.hydrateTimelineFromProvider(agentId, {
    broadcast: () => pending.options.broadcastTimeline,
  });
  return deps.agentManager.getAgent(agentId) ?? snapshot;
}

async function reuseLoadedAgent(
  agent: ManagedAgent,
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent | null> {
  if (agent.sessionExecutionMode !== "history-only") {
    return agent;
  }

  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    return agent;
  }

  await deps.agentManager.closeAgent(agentId);
  await deps.agentManager.waitForAgentClose?.(agentId);
  return null;
}

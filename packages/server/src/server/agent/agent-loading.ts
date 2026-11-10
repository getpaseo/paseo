import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractAttention,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

const pendingAgentInitializations = new Map<string, Promise<ManagedAgent>>();

export type AgentLoaderManager = Pick<
  AgentManager,
  "createAgent" | "getAgent" | "getRegisteredProviderIds" | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  logger: Logger;
}

/** The agent's history to read: from its runtime, or stored, with no provider session opened. */
export type AgentHistorySource =
  | { kind: "live"; agent: ManagedAgent }
  | { kind: "stored"; record: StoredAgentRecord };

export interface LoadAgentHistoryDeps extends EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager & Pick<AgentManager, "hasStoredHistory">;
}

/**
 * Resolves an agent for reading its history. A loaded agent is read live. A stored agent whose
 * history the timeline holds is read without resuming its provider, so it reads even when its
 * provider is no longer available. Otherwise the provider is resumed, which imports its history
 * and requires the provider.
 */
export async function loadAgentHistory(
  agentId: string,
  deps: LoadAgentHistoryDeps,
): Promise<AgentHistorySource> {
  const live = deps.agentManager.getAgent(agentId);
  if (live) return { kind: "live", agent: live };
  const record = await deps.agentStorage.get(agentId);
  if (!record) throw new AgentNotFoundError(agentId);
  if (await deps.agentManager.hasStoredHistory(agentId)) {
    return { kind: "stored", record };
  }
  return { kind: "live", agent: await ensureAgentLoaded(agentId, deps) };
}

async function requireLoadableRecord(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<StoredAgentRecord> {
  const record = await deps.agentStorage.get(agentId);
  if (!record) {
    throw new AgentNotFoundError(agentId);
  }
  const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
  if (!isStoredAgentProviderAvailable(record, validProviders)) {
    throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
  }
  return record;
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
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    return inflight;
  }

  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    return existing;
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) {
    return laterInflight;
  }

  const initPromise = (async () => {
    const record = await requireLoadableRecord(agentId, deps);
    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        { ...extractTimestamps(record), attention: extractAttention(record) },
        record.archivedAt ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      // No provider handle to resume: this starts the agent's first session rather than
      // bringing one back, so it stamps activity and carries no stored attention. Records
      // without a handle never got far enough to accumulate either.
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
        env: record.launchEnv,
      });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  pendingAgentInitializations.set(agentId, initPromise);

  try {
    return await initPromise;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === initPromise) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}

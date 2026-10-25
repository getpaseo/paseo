import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { ManagedOpeningRequest } from "./managed-opening.js";
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

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: {
    broadcastTimeline: boolean;
    openingRequest?: ManagedOpeningRequest;
    readOnly?: boolean;
  };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
  openingRequest?: ManagedOpeningRequest;
  /** Reads state only: a managed agent loads without reserving an opening or minting a credential. */
  readOnly?: boolean;
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

async function joinInflight(
  agentId: string,
  inflight: PendingAgentInitialization,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  if (inflight.options.readOnly && !deps.readOnly) {
    // A reading-only load cannot satisfy a caller that may run the agent.
    await inflight.promise.catch(() => undefined);
    return ensureAgentLoaded(agentId, deps);
  }
  if (deps.openingRequest && inflight.options.openingRequest?.key !== deps.openingRequest.key) {
    throw new Error(
      "Managed opening is already in progress; reconcile before requesting another refresh",
    );
  }
  inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
  return inflight.promise;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) return joinInflight(agentId, inflight, deps);

  const existing = deps.agentManager.getAgent(agentId);
  // A reading-only managed resident never ran an opening, so a caller that may run it reloads.
  if (existing && !(existing.historyOnly && !deps.readOnly)) {
    if (
      deps.openingRequest &&
      existing.config.managedMcpServers &&
      !(await deps.agentStorage.managedOpenings.checkRequest(agentId, deps.openingRequest))
    ) {
      throw new Error(
        "Managed agent became resident without this refresh receipt; reconcile before another refresh",
      );
    }
    return existing;
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) return joinInflight(agentId, laterInflight, deps);

  const pendingOptions = {
    broadcastTimeline: deps.broadcastTimeline === true,
    openingRequest: deps.openingRequest,
    readOnly: deps.readOnly === true,
  };
  const initPromise = (async () => {
    const record = await deps.agentStorage.get(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
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
          attention: extractAttention(record),
          openingRequest: deps.openingRequest,
        },
        record.archivedAt || deps.readOnly ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      // No provider handle to resume: this starts the agent's first session rather than
      // bringing one back, so it stamps activity and carries no stored attention. Records
      // without a handle never got far enough to accumulate either.
      if (deps.readOnly && record.config?.managedMcpServers) {
        throw new Error("Managed agent has no resumable session to read; start a fresh execution");
      }
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
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = { promise: initPromise, options: pendingOptions };
  pendingAgentInitializations.set(agentId, pending);

  try {
    return await initPromise;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}

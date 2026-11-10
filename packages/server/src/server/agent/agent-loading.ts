import type { Logger } from "pino";

import type {
  AgentProvider,
  AgentSessionConfigChange,
  AgentResumeSessionOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  buildConfigOverrides,
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
  options: { broadcastTimeline: boolean };
  hasConfigChange: boolean;
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgentFromRecord"
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
  purpose?: "history" | "interactive";
  /** Explicit settings mutation: validate this selection while opening, before persisting it. */
  configOverrides?: AgentSessionConfigChange;
  onConfigApplied?: AgentResumeSessionOptions["onConfigApplied"];
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
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return waitForPendingInitialization({ agentId, deps, pending: inflight });
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
    laterInflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return waitForPendingInitialization({ agentId, deps, pending: laterInflight });
  }

  const pendingOptions = {
    broadcastTimeline: deps.broadcastTimeline === true,
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
    try {
      if (handle) {
        snapshot = await deps.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          { ...extractTimestamps(record), attention: extractAttention(record) },
          {
            purpose: deps.purpose,
            configChange: deps.configOverrides,
            onConfigApplied: deps.onConfigApplied,
          },
        );
        deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
      } else {
        // No provider handle to resume: this starts the agent's first session rather than
        // bringing one back, so it stamps activity and carries no stored attention. Records
        // without a handle never got far enough to accumulate either. The manager rereads the
        // record inside the agent's lane, so a write that lands after this read is not lost.
        snapshot = await deps.agentManager.createAgentFromRecord(
          agentId,
          deps.configOverrides,
          deps.onConfigApplied,
        );
        deps.logger.info(
          { agentId, provider: record.provider },
          "Agent created from stored config",
        );
      }
    } catch (error) {
      // A later config setter can reject after the validated prefix was registered.
      // Its timeline must be hydrated just like any other successfully opened session.
      if (deps.agentManager.getAgent(agentId)) {
        await deps.agentManager.hydrateTimelineFromProvider(agentId, {
          broadcast: () => pendingOptions.broadcastTimeline,
        });
      }
      throw error;
    }
    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = {
    promise: initPromise,
    options: pendingOptions,
    hasConfigChange: deps.configOverrides !== undefined,
  };
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

async function waitForPendingInitialization({
  agentId,
  deps,
  pending,
}: {
  agentId: string;
  deps: EnsureAgentLoadedDeps;
  pending: PendingAgentInitialization;
}): Promise<ManagedAgent> {
  if (!pending.hasConfigChange && deps.configOverrides === undefined) return pending.promise;
  // A mutation owns its selection and rejection. An ordinary load may fail on the
  // saved preference that this caller repairs; it must still try its own selection.
  await pending.promise.catch(() => undefined);
  return ensureAgentLoaded(agentId, deps);
}

import type { Logger } from "pino";

import type { AgentProvider, AgentResumeSessionOptions } from "./agent-sdk-types.js";
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
  /**
   * Opens a cold agent read-only from a bounded history page, as every request made while a chat
   * opens must. "tail" leaves the rest to the timeline reader. "full" then replays everything,
   * after caching that tail so the chat's timeline read never waits for the replay.
   */
  history?: "tail" | "full";
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

function resumeOptionsFor(deps: EnsureAgentLoadedDeps): AgentResumeSessionOptions | undefined {
  if (deps.history) return { purpose: "history", progressiveHistory: true };
  return deps.purpose ? { purpose: deps.purpose } : undefined;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  const finishLoad = async (snapshot: ManagedAgent): Promise<ManagedAgent> => {
    // Interactive sends upgrade a progressive history session in the run
    // pipeline. Do not replay the entire provider history before dispatching
    // the prompt; that turns a reply start into the same unbounded operation
    // as a cold full-history read.
    if (deps.purpose !== "interactive" && deps.history !== "tail" && !snapshot.historyPrimed) {
      await deps.agentManager.hydrateTimelineFromProvider(agentId, {
        broadcast: () =>
          pendingAgentInitializations.get(agentId)?.options.broadcastTimeline ??
          deps.broadcastTimeline === true,
      });
    }
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  };
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return finishLoad(await inflight.promise);
  }

  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    // A live agent already owns its provider session. Keep the historical fast
    // path for ordinary callers; timeline readers explicitly ask for a tail or
    // promote through the history lane when they need provider data.
    return existing;
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) {
    laterInflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return finishLoad(await laterInflight.promise);
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
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        { ...extractTimestamps(record), attention: extractAttention(record) },
        resumeOptionsFor(deps),
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      // No provider handle to resume: this starts the agent's first session rather than
      // bringing one back, so it stamps activity and carries no stored attention. Records
      // without a handle never got far enough to accumulate either. The manager rereads the
      // record inside the agent's lane, so a write that lands after this read is not lost.
      snapshot = await deps.agentManager.createAgentFromRecord(agentId);
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = { promise: initPromise, options: pendingOptions };
  pendingAgentInitializations.set(agentId, pending);

  try {
    return await finishLoad(await initPromise);
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}

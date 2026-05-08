import type { Logger } from "pino";

import type { AgentPersistenceHandle, AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { TmuxCodexBridgeService } from "../tmux-codex-bridge-service.js";
import type { CodexProcessBridgeService } from "../codex-process-bridge-service.js";
import { isCodexProcessHandle } from "../codex-process-bridge.js";
import { isTmuxCodexHandle } from "../tmux-codex-bridge.js";
import {
  buildExternalBridgeSessionConfig,
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

const pendingAgentInitializations = new Map<string, Promise<ManagedAgent>>();

export interface EnsureAgentLoadedDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  tmuxCodexBridge?: TmuxCodexBridgeService | null;
  codexProcessBridge?: CodexProcessBridgeService | null;
  logger: Logger;
}

function shouldRelaunchExternalCodexSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("tmux codex session not found") ||
    message.includes("codex process session not found")
  );
}

async function resumeAgentThroughExternalBridge(input: {
  deps: EnsureAgentLoadedDeps;
  handle: AgentPersistenceHandle;
  agentId: string;
  config: AgentSessionConfig;
  labels?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
  lastUserMessageAt?: Date | null;
}): Promise<ManagedAgent | null> {
  if (isTmuxCodexHandle(input.handle)) {
    if (!input.deps.tmuxCodexBridge) {
      throw new Error("tmux codex bridge is not available");
    }
    try {
      return await input.deps.tmuxCodexBridge.resumeFromPersistence(input);
    } catch (error) {
      if (!shouldRelaunchExternalCodexSession(error)) {
        throw error;
      }
      return await input.deps.tmuxCodexBridge.relaunchFromPersistence(input);
    }
  }

  if (isCodexProcessHandle(input.handle)) {
    if (!input.deps.codexProcessBridge) {
      throw new Error("codex process bridge is not available");
    }
    try {
      return await input.deps.codexProcessBridge.resumeFromPersistence(input);
    } catch (error) {
      if (!shouldRelaunchExternalCodexSession(error)) {
        throw error;
      }
      if (!input.deps.tmuxCodexBridge) {
        throw new Error(
          "Cannot relaunch external Codex session because the tmux bridge is not available",
        );
      }
      return await input.deps.tmuxCodexBridge.relaunchFromPersistence(input);
    }
  }

  return null;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    return existing;
  }

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    return inflight;
  }

  const initPromise = (async () => {
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
      const bridgedSnapshot = await resumeAgentThroughExternalBridge({
        deps,
        handle,
        agentId,
        config: buildExternalBridgeSessionConfig(record),
        labels: record.labels,
        ...extractTimestamps(record),
      });
      if (bridgedSnapshot) {
        snapshot = bridgedSnapshot;
        deps.logger.info(
          {
            agentId,
            provider: record.provider,
            externalSessionSource: handle.metadata?.externalSessionSource,
          },
          "External Codex session resumed from bridge persistence",
        );
      } else {
        snapshot = await deps.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          extractTimestamps(record),
        );
        deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
      }
    } else {
      const config = buildSessionConfig(record, {
        validProviders,
      });
      if (!config) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }
      snapshot = await deps.agentManager.createAgent(config, agentId, { labels: record.labels });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId);
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

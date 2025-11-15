import type { AgentManager } from "./agent/agent-manager.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type {
  AgentRegistry,
  StoredAgentRecord,
} from "./agent/agent-registry.js";

type AgentRegistryPersistence = Pick<AgentRegistry, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;
type AgentManagerRestorer = Pick<AgentManager, "resumeAgent" | "createAgent">;

/**
 * Attach AgentRegistry persistence to an AgentManager instance so every
 * agent_state snapshot is flushed to disk.
 */
export function attachAgentRegistryPersistence(
  agentManager: AgentManagerStateSource,
  registry: AgentRegistryPersistence
): () => void {
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    void registry.applySnapshot(event.agent).catch((error) => {
      console.error("[AgentRegistry] Failed to persist agent snapshot:", error);
    });
  });

  return unsubscribe;
}

/**
 * Restore persisted agents from the AgentRegistry at server startup.
 */
export async function restorePersistedAgents(
  agentManager: AgentManagerRestorer,
  registry: AgentRegistryPersistence
): Promise<void> {
  const records = await registry.list();
  if (records.length === 0) {
    return;
  }

  console.log(`[Agents] Restoring ${records.length} persisted agent(s)`);
  for (const record of records) {
    if (!isKnownProvider(record.provider)) {
      console.warn(
        `[Agents] Skipping persisted agent ${record.id} with unknown provider '${record.provider}'`
      );
      continue;
    }

    try {
      const persistenceHandle = buildPersistenceHandle(record);
      if (persistenceHandle) {
        await agentManager.resumeAgent(
          persistenceHandle,
          buildConfigOverrides(record),
          record.id
        );
      } else {
        await agentManager.createAgent(
          buildSessionConfig(record),
          record.id
        );
      }
    } catch (error) {
      console.error(
        `[Agents] Failed to restore agent ${record.id}:`,
        error
      );
    }
  }
}

function isKnownProvider(provider: string): provider is AgentProvider {
  return provider === "claude" || provider === "codex";
}

function buildPersistenceHandle(
  record: StoredAgentRecord
): AgentPersistenceHandle | null {
  if (!record.persistence) {
    return null;
  }
  const { provider, sessionId, nativeHandle, metadata } = record.persistence;
  if (!isKnownProvider(provider)) {
    console.warn(
      `[Agents] Skipping persisted handle for ${record.id} with unknown provider '${provider}'`
    );
    return null;
  }
  return {
    provider,
    sessionId,
    nativeHandle,
    metadata,
  } satisfies AgentPersistenceHandle;
}

export function buildConfigOverrides(
  record: StoredAgentRecord
): Partial<AgentSessionConfig> {
  return {
    cwd: record.cwd,
    modeId: record.lastModeId ?? record.config?.modeId ?? undefined,
    model: record.config?.model ?? undefined,
    extra: record.config?.extra ?? undefined,
  };
}

export function buildSessionConfig(
  record: StoredAgentRecord
): AgentSessionConfig {
  if (!isKnownProvider(record.provider)) {
    throw new Error(`Unknown provider '${record.provider}'`);
  }
  const overrides = buildConfigOverrides(record);
  return {
    provider: record.provider,
    cwd: record.cwd,
    modeId: overrides.modeId,
    model: overrides.model,
    extra: overrides.extra,
  };
}

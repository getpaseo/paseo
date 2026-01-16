import type { AgentManager } from "./agent/agent-manager.js";
import type {
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type {
  AgentRegistry,
  StoredAgentRecord,
} from "./agent/agent-registry.js";

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  error(...args: any[]): void;
};

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

type AgentRegistryPersistence = Pick<AgentRegistry, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;

function isKnownProvider(provider: string): provider is AgentProvider {
  return provider === "claude" || provider === "codex";
}

/**
 * Attach AgentRegistry persistence to an AgentManager instance so every
 * agent_state snapshot is flushed to disk.
 */
export function attachAgentRegistryPersistence(
  logger: LoggerLike,
  agentManager: AgentManagerStateSource,
  registry: AgentRegistryPersistence
): () => void {
  const log = getLogger(logger);
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    void registry.applySnapshot(event.agent).catch((error) => {
      log.error({ err: error, agentId: event.agent.id }, "Failed to persist agent snapshot");
    });
  });

  return unsubscribe;
}

export function buildConfigOverrides(
  record: StoredAgentRecord
): Partial<AgentSessionConfig> {
  return {
    cwd: record.cwd,
    modeId: record.lastModeId ?? record.config?.modeId ?? undefined,
    model: record.config?.model ?? undefined,
    title: record.title ?? undefined,
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
    title: overrides.title,
    extra: overrides.extra,
  };
}

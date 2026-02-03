import type { AgentManager } from "./agent/agent-manager.js";
import type {
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type {
  AgentStorage,
  StoredAgentRecord,
} from "./agent/agent-storage.js";

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  error(...args: any[]): void;
};

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

type AgentStoragePersistence = Pick<AgentStorage, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;

function isKnownProvider(provider: string): provider is AgentProvider {
  return provider === "claude" || provider === "codex";
}

/**
 * Attach AgentStorage persistence to an AgentManager instance so every
 * agent_state snapshot is flushed to disk.
 */
export function attachAgentStoragePersistence(
  logger: LoggerLike,
  agentManager: AgentManagerStateSource,
  storage: AgentStoragePersistence
): () => void {
  const log = getLogger(logger);
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    void storage.applySnapshot(event.agent).catch((error) => {
      log.error({ err: error, agentId: event.agent.id }, "Failed to persist agent snapshot");
    });
  });

  return unsubscribe;
}

export function buildConfigOverrides(
  record: StoredAgentRecord
): Partial<AgentSessionConfig> {
  const thinkingOptionId =
    record.config?.thinkingOptionId ?? record.config?.reasoningEffort ?? undefined;
  return {
    cwd: record.cwd,
    modeId: record.lastModeId ?? record.config?.modeId ?? undefined,
    model: record.config?.model ?? undefined,
    thinkingOptionId,
    variantId: record.config?.variantId ?? undefined,
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
    thinkingOptionId: overrides.thinkingOptionId,
    variantId: overrides.variantId,
    title: overrides.title,
    extra: overrides.extra,
  };
}

export function extractTimestamps(
  record: StoredAgentRecord
): {
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt: Date | null;
  labels?: Record<string, string>;
} {
  return {
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.lastActivityAt ?? record.updatedAt),
    lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
    labels: record.labels,
  };
}

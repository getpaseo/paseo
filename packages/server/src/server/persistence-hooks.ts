import type { AgentManager } from "./agent/agent-manager.js";
import { stripInternalPaseoMcpServer } from "./agent/runtime-mcp-config.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { AttentionState } from "./agent/agent-manager.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

type AgentStoragePersistence = Pick<AgentStorage, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;

interface BuildSessionConfigOptions {
  validProviders?: Iterable<AgentProvider>;
}

function isProviderRegistered(
  validProviders: Iterable<AgentProvider> | undefined,
  provider: AgentProvider,
): boolean {
  if (!validProviders) {
    return true;
  }
  if (validProviders instanceof Set) {
    return validProviders.has(provider);
  }
  return new Set(validProviders).has(provider);
}

/**
 * Attach AgentStorage persistence to an AgentManager instance so every
 * agent_state snapshot is flushed to disk.
 */
export function attachAgentStoragePersistence(
  logger: LoggerLike,
  agentManager: AgentManagerStateSource,
  storage: AgentStoragePersistence,
): () => void {
  const log = getLogger(logger);
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    if (event.agent.lifecycle === "closed") {
      return;
    }
    void storage.applySnapshot(event.agent).catch((error) => {
      log.error({ err: error, agentId: event.agent.id }, "Failed to persist agent snapshot");
    });
  });

  return unsubscribe;
}

export function buildConfigOverrides(record: StoredAgentRecord): Partial<AgentSessionConfig> {
  return stripInternalPaseoMcpServer({
    provider: record.provider,
    cwd: record.cwd,
    modeId: record.config?.modeId ?? undefined,
    model: record.config?.model ?? undefined,
    thinkingOptionId: record.config?.thinkingOptionId ?? undefined,
    featureValues: record.config?.featureValues ?? undefined,
    providerOptions: record.config?.providerOptions ?? undefined,
    toolPolicy: record.config?.toolPolicy ?? undefined,
    systemPrompt: record.config?.systemPrompt ?? undefined,
    mcpServers: record.config?.mcpServers ?? undefined,
  });
}

export function buildSessionConfig(
  record: StoredAgentRecord,
  options?: BuildSessionConfigOptions,
): AgentSessionConfig | null {
  if (!isProviderRegistered(options?.validProviders, record.provider)) {
    return null;
  }
  const overrides = buildConfigOverrides(record);
  return stripInternalPaseoMcpServer({
    provider: record.provider,
    cwd: record.cwd,
    modeId: overrides.modeId,
    model: overrides.model,
    thinkingOptionId: overrides.thinkingOptionId,
    featureValues: overrides.featureValues,
    providerOptions: overrides.providerOptions,
    toolPolicy: overrides.toolPolicy,
    systemPrompt: overrides.systemPrompt,
    mcpServers: overrides.mcpServers,
  });
}

export function isStoredAgentProviderAvailable(
  record: StoredAgentRecord,
  validProviders?: Iterable<AgentProvider>,
): boolean {
  return isProviderRegistered(validProviders, record.provider);
}

/**
 * When the record last changed, from either of the two timestamps it carries. They diverge
 * because renaming, labelling, restoring from archive, marking unread, and clearing attention
 * all move `updatedAt` on an unloaded agent without touching `lastActivityAt`. Reading one
 * field alone hands consumers a time older than one they have already seen, and
 * `acceptAgentDirectoryUpdate` drops every state update that goes backwards.
 */
export function resolveStoredAgentUpdatedAt(record: StoredAgentRecord): string {
  const timestamps = [record.updatedAt, record.lastActivityAt]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => ({
      raw: value,
      parsed: Date.parse(value),
    }))
    .filter((value) => !Number.isNaN(value.parsed));

  if (timestamps.length === 0) {
    return record.updatedAt;
  }

  timestamps.sort((a, b) => b.parsed - a.parsed);
  return timestamps[0].raw;
}

export function extractTimestamps(record: StoredAgentRecord): {
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt: Date | null;
  labels?: Record<string, string>;
  workspaceId?: string;
  owner?: StoredAgentRecord["owner"];
} {
  return {
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(resolveStoredAgentUpdatedAt(record)),
    lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
    labels: record.labels,
    workspaceId: record.workspaceId,
    owner: record.owner,
  };
}

/**
 * Unread state survives a resume. Attention is set by the agent finishing or failing and
 * cleared by the user reading the chat (`workspace.clear_attention`); reloading the runtime
 * is neither, so a resumed agent that drops it silently marks the chat read.
 */
export function extractAttention(record: StoredAgentRecord): AttentionState {
  if (!record.requiresAttention || !record.attentionReason || !record.attentionTimestamp) {
    return { requiresAttention: false };
  }
  return {
    requiresAttention: true,
    attentionReason: record.attentionReason,
    attentionTimestamp: new Date(record.attentionTimestamp),
  };
}

export function toAgentPersistenceHandle(
  registeredProviders: Iterable<AgentProvider>,
  handle: StoredAgentRecord["persistence"],
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!isProviderRegistered(registeredProviders, provider)) {
    return null;
  }
  if (!handle.sessionId) {
    return null;
  }
  return {
    provider,
    sessionId: handle.sessionId,
    ...(handle.nativeHandle !== undefined ? { nativeHandle: handle.nativeHandle } : {}),
    ...(handle.metadata !== undefined ? { metadata: handle.metadata } : {}),
  } satisfies AgentPersistenceHandle;
}

import { basename } from "node:path";

import type { AgentManager } from "./agent/agent-manager.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import { buildProviderRegistry } from "./agent/provider-registry.js";

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  error(...args: any[]): void;
  warn(...args: any[]): void;
};

const DEFAULT_AGENT_PROVIDER = "claude";

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

function normalizeStoredTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readTmuxRuntimeExtra(record: Pick<StoredAgentRecord, "runtimeInfo">): Record<string, unknown> {
  const extra = record.runtimeInfo?.extra;
  return extra && typeof extra === "object" ? (extra as Record<string, unknown>) : {};
}

function readTmuxConfigExtra(record: Pick<StoredAgentRecord, "config">): Record<string, unknown> {
  const extra = record.config?.extra;
  if (!extra || typeof extra !== "object") {
    return {};
  }
  const codex = (extra as Record<string, unknown>).codex;
  return codex && typeof codex === "object" ? (codex as Record<string, unknown>) : {};
}

function readTmuxPaneId(record: Pick<StoredAgentRecord, "config" | "runtimeInfo" | "persistence">): string | null {
  const runtimeExtra = readTmuxRuntimeExtra(record);
  const configExtra = readTmuxConfigExtra(record);
  const candidates = [
    record.persistence?.metadata?.paneId,
    runtimeExtra.paneId,
    configExtra.paneId,
    record.persistence?.sessionId,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeStoredTitle(candidate);
    if (normalized?.startsWith("%")) {
      return normalized;
    }
  }
  return null;
}

function isTmuxCodexRecord(
  record: Pick<StoredAgentRecord, "labels" | "config" | "runtimeInfo" | "persistence">,
): boolean {
  const runtimeExtra = readTmuxRuntimeExtra(record);
  const configExtra = readTmuxConfigExtra(record);
  const labels = record.labels ?? {};
  const sourceCandidates = [
    record.persistence?.metadata?.externalSessionSource,
    runtimeExtra.externalSessionSource,
    configExtra.externalSessionSource,
  ];
  return (
    labels.source === "tmux" ||
    sourceCandidates.some((value) => normalizeStoredTitle(value) === "tmux_codex")
  );
}

function isGeneratedTmuxFallbackTitle(input: {
  title: string | null | undefined;
  paneId: string;
  cwd: string;
}): boolean {
  const normalizedTitle = normalizeStoredTitle(input.title);
  return normalizedTitle === `${basename(input.cwd)} [tmux:${input.paneId}]`;
}

export function resolveStoredAgentTitle(record: StoredAgentRecord): string | null {
  const persistedTitle = normalizeStoredTitle(record.title);
  if (!isTmuxCodexRecord(record)) {
    return persistedTitle ?? normalizeStoredTitle(record.config?.title);
  }

  const paneId = readTmuxPaneId(record);
  const hasCustomPersistedTitle =
    persistedTitle &&
    (!paneId ||
      !isGeneratedTmuxFallbackTitle({
        title: persistedTitle,
        paneId,
        cwd: record.cwd,
      }));
  if (hasCustomPersistedTitle) {
    return persistedTitle;
  }

  const runtimeExtra = readTmuxRuntimeExtra(record);
  return (
    normalizeStoredTitle(record.config?.title) ??
    normalizeStoredTitle(record.persistence?.metadata?.title) ??
    normalizeStoredTitle(record.persistence?.metadata?.paneTitle) ??
    normalizeStoredTitle(runtimeExtra.title) ??
    persistedTitle
  );
}

type AgentStoragePersistence = Pick<AgentStorage, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;

type BuildSessionConfigOptions = {
  validProviders?: Iterable<AgentProvider>;
  logger?: LoggerLike;
};

type RegisteredProviders = ReturnType<typeof buildProviderRegistry> | Iterable<AgentProvider>;

function isProviderRegistry(
  registeredProviders: RegisteredProviders,
): registeredProviders is ReturnType<typeof buildProviderRegistry> {
  return (
    typeof registeredProviders === "object" &&
    registeredProviders !== null &&
    !(Symbol.iterator in registeredProviders)
  );
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
    void storage.applySnapshot(event.agent).catch((error) => {
      log.error({ err: error, agentId: event.agent.id }, "Failed to persist agent snapshot");
    });
  });

  return unsubscribe;
}

export function buildConfigOverrides(record: StoredAgentRecord): Partial<AgentSessionConfig> {
  return {
    cwd: record.cwd,
    modeId: record.lastModeId ?? record.config?.modeId ?? undefined,
    model: record.config?.model ?? undefined,
    thinkingOptionId: record.config?.thinkingOptionId ?? undefined,
    featureValues: record.config?.featureValues ?? undefined,
    title: record.config?.title ?? undefined,
    extra: record.config?.extra ?? undefined,
    systemPrompt: record.config?.systemPrompt ?? undefined,
    mcpServers: record.config?.mcpServers ?? undefined,
  };
}

export function buildSessionConfig(
  record: StoredAgentRecord,
  options?: BuildSessionConfigOptions,
): AgentSessionConfig | null {
  const validProviders = options?.validProviders;
  const isValidProvider = validProviders ? new Set(validProviders).has(record.provider) : true;
  if (!isValidProvider) {
    options?.logger?.warn(
      { agentId: record.id, provider: record.provider },
      `Skipping persisted agent with unknown provider '${record.provider}'`,
    );
    return null;
  }
  const overrides = buildConfigOverrides(record);
  return {
    provider: record.provider,
    cwd: record.cwd,
    modeId: overrides.modeId,
    model: overrides.model,
    thinkingOptionId: overrides.thinkingOptionId,
    featureValues: overrides.featureValues,
    title: overrides.title,
    extra: overrides.extra,
    systemPrompt: overrides.systemPrompt,
    mcpServers: overrides.mcpServers,
  };
}

export function buildExternalBridgeSessionConfig(record: StoredAgentRecord): AgentSessionConfig {
  const config = buildSessionConfig(record);
  return {
    ...config,
    title: resolveStoredAgentTitle(record) ?? config.title,
  };
}

export function extractTimestamps(record: StoredAgentRecord): {
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

function hasRegisteredProvider(registeredProviders: RegisteredProviders, value: string): boolean {
  if (isProviderRegistry(registeredProviders)) {
    return Object.prototype.hasOwnProperty.call(registeredProviders, value);
  }
  return new Set(registeredProviders).has(value as AgentProvider);
}

export function isRegisteredProvider(
  providerRegistry: ReturnType<typeof buildProviderRegistry>,
  value: string,
): boolean {
  return hasRegisteredProvider(providerRegistry, value);
}

export function coerceAgentProvider(
  logger: LoggerLike,
  providerRegistry: ReturnType<typeof buildProviderRegistry>,
  value: string,
  agentId?: string,
): AgentProvider {
  if (isRegisteredProvider(providerRegistry, value)) {
    return value;
  }
  logger.warn(
    { value, agentId, defaultProvider: DEFAULT_AGENT_PROVIDER },
    `Unknown provider '${value}' for agent ${agentId ?? "unknown"}; defaulting to '${DEFAULT_AGENT_PROVIDER}'`,
  );
  return DEFAULT_AGENT_PROVIDER;
}

export function toAgentPersistenceHandle(
  logger: LoggerLike,
  registeredProviders: RegisteredProviders,
  handle: StoredAgentRecord["persistence"],
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!hasRegisteredProvider(registeredProviders, provider)) {
    logger.warn({ provider }, `Ignoring persistence handle with unknown provider '${provider}'`);
    return null;
  }
  if (!handle.sessionId) {
    logger.warn("Ignoring persistence handle missing sessionId");
    return null;
  }
  return {
    provider,
    sessionId: handle.sessionId,
    ...(handle.nativeHandle !== undefined ? { nativeHandle: handle.nativeHandle } : {}),
    ...(handle.metadata !== undefined ? { metadata: handle.metadata } : {}),
  } satisfies AgentPersistenceHandle;
}

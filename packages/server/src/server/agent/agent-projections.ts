import type { AgentSnapshotPayload } from "../messages.js";
import type {
  SerializableAgentConfig,
  StoredAgentRecord,
} from "./agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentMetadata,
  AgentMode,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
  AgentRuntimeInfo,
  AgentUsage,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { JsonValue } from "../json-utils.js";

export type { ManagedAgent };

type ProjectionOptions = {
  title?: string | null;
  createdAt?: string;
  internal?: boolean;
};

function normalizeThinkingOptionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveEffectiveThinkingOptionId(options: {
  runtimeInfo?: AgentRuntimeInfo | null;
  configuredThinkingOptionId?: string | null;
}): string | null {
  const runtimeInfo = options.runtimeInfo;
  if (runtimeInfo && "thinkingOptionId" in runtimeInfo) {
    return normalizeThinkingOptionId(runtimeInfo.thinkingOptionId);
  }
  return normalizeThinkingOptionId(options.configuredThinkingOptionId);
}

export function toStoredAgentRecord(
  agent: ManagedAgent,
  options?: ProjectionOptions
): StoredAgentRecord {
  const createdAt = options?.createdAt ?? agent.createdAt.toISOString();
  const config = buildSerializableConfig(agent.config);
  const persistence = sanitizePersistenceHandle(agent.persistence);
  const runtimeInfo = sanitizeRuntimeInfo(agent.runtimeInfo);

  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    createdAt,
    updatedAt: agent.updatedAt.toISOString(),
    lastActivityAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt
      ? agent.lastUserMessageAt.toISOString()
      : null,
    title: options?.title ?? null,
    labels: agent.labels,
    lastStatus: agent.lifecycle,
    lastModeId: agent.currentModeId ?? config?.modeId ?? null,
    config: config ?? null,
    runtimeInfo,
    persistence,
    requiresAttention: agent.attention.requiresAttention,
    attentionReason: agent.attention.requiresAttention
      ? agent.attention.attentionReason
      : null,
    attentionTimestamp: agent.attention.requiresAttention
      ? agent.attention.attentionTimestamp.toISOString()
      : null,
    internal: options?.internal,
  } satisfies StoredAgentRecord;
}

export function toAgentPayload(
  agent: ManagedAgent,
  options?: ProjectionOptions
): AgentSnapshotPayload {
  const runtimeInfo = sanitizeRuntimeInfo(agent.runtimeInfo);
  const thinkingOptionId = agent.config.thinkingOptionId ?? null;
  const effectiveThinkingOptionId = resolveEffectiveThinkingOptionId({
    runtimeInfo,
    configuredThinkingOptionId: thinkingOptionId,
  });

  const payload: AgentSnapshotPayload = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    model: agent.config.model ?? null,
    thinkingOptionId,
    effectiveThinkingOptionId,
    runtimeInfo,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt
      ? agent.lastUserMessageAt.toISOString()
      : null,
    status: agent.lifecycle,
    capabilities: cloneCapabilities(agent.capabilities),
    currentModeId: agent.currentModeId,
    availableModes: cloneAvailableModes(agent.availableModes),
    pendingPermissions: sanitizePendingPermissions(agent.pendingPermissions),
    persistence: sanitizePersistenceHandle(agent.persistence),
    title: options?.title ?? null,
    labels: agent.labels,
  };

  const usage = sanitizeUsage(agent.lastUsage);
  if (usage !== undefined) {
    payload.lastUsage = usage;
  }

  if (agent.lastError !== undefined) {
    payload.lastError = agent.lastError;
  }

  // Handle attention state
  payload.requiresAttention = agent.attention.requiresAttention;
  if (agent.attention.requiresAttention) {
    payload.attentionReason = agent.attention.attentionReason;
    payload.attentionTimestamp = agent.attention.attentionTimestamp.toISOString();
  } else {
    payload.attentionReason = null;
    payload.attentionTimestamp = null;
  }

  return payload;
}

function buildSerializableConfig(
  config: AgentSessionConfig
): SerializableAgentConfig | null {
  const serializable: SerializableAgentConfig = {};
  if (config.modeId) {
    serializable.modeId = config.modeId;
  }
  if (config.model) {
    serializable.model = config.model;
  }
  if (config.thinkingOptionId) {
    serializable.thinkingOptionId = config.thinkingOptionId;
  }
  const extra = sanitizeMetadata(config.extra);
  if (extra !== undefined) {
    serializable.extra = extra;
  }
  if (config.systemPrompt) {
    serializable.systemPrompt = config.systemPrompt;
  }
  if (config.mcpServers) {
    serializable.mcpServers = config.mcpServers;
  }
  return Object.keys(serializable).length ? serializable : null;
}

function sanitizePendingPermissions(
  pending: Map<string, AgentPermissionRequest>
): AgentPermissionRequest[] {
  return Array.from(pending.values()).map((request) => (
    {
      ...request,
      input: sanitizeMetadata(request.input),
      suggestions: sanitizeMetadataArray(request.suggestions),
      metadata: sanitizeMetadata(request.metadata),
    }
  ));
}

function sanitizePersistenceHandle(
  handle: AgentPersistenceHandle | null
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const sanitized: AgentPersistenceHandle = {
    provider: handle.provider,
    sessionId: handle.sessionId,
  };
  if (handle.nativeHandle !== undefined) {
    sanitized.nativeHandle = handle.nativeHandle;
  }
  const metadata = sanitizeMetadata(handle.metadata);
  if (metadata !== undefined) {
    sanitized.metadata = metadata;
  }
  return sanitized;
}

function cloneCapabilities(
  capabilities: AgentCapabilityFlags
): AgentCapabilityFlags {
  return { ...capabilities };
}

function cloneAvailableModes(modes: AgentMode[]): AgentMode[] {
  return modes.map((mode) => ({ ...mode }));
}

function sanitizeOptionalJson(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    const sanitized = value
      .map((item) => sanitizeOptionalJson(item))
      .filter((item) => item !== undefined);
    return sanitized;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, val] of Object.entries(value)) {
      const sanitized = sanitizeOptionalJson(val);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return Object.keys(result).length ? result : undefined;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function isJsonObject(
  value: JsonValue
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMetadata(value: unknown): AgentMetadata | undefined {
  const sanitized = sanitizeOptionalJson(value);
  if (!sanitized || !isJsonObject(sanitized)) {
    return undefined;
  }
  return sanitized;
}

function sanitizeMetadataArray(value: unknown): AgentMetadata[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sanitized = value
    .map((entry) => sanitizeMetadata(entry))
    .filter((entry): entry is AgentMetadata => entry !== undefined);
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeUsage(value: unknown): AgentUsage | undefined {
  const sanitized = sanitizeOptionalJson(value);
  if (!sanitized || !isJsonObject(sanitized)) {
    return undefined;
  }
  const result: AgentUsage = {};
  const inputTokens = sanitized.inputTokens;
  if (typeof inputTokens === "number") {
    result.inputTokens = inputTokens;
  } else if (inputTokens !== undefined && inputTokens !== null) {
    return undefined;
  }
  const cachedInputTokens = sanitized.cachedInputTokens;
  if (typeof cachedInputTokens === "number") {
    result.cachedInputTokens = cachedInputTokens;
  } else if (cachedInputTokens !== undefined && cachedInputTokens !== null) {
    return undefined;
  }
  const outputTokens = sanitized.outputTokens;
  if (typeof outputTokens === "number") {
    result.outputTokens = outputTokens;
  } else if (outputTokens !== undefined && outputTokens !== null) {
    return undefined;
  }
  const totalCostUsd = sanitized.totalCostUsd;
  if (typeof totalCostUsd === "number") {
    result.totalCostUsd = totalCostUsd;
  } else if (totalCostUsd !== undefined && totalCostUsd !== null) {
    return undefined;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeRuntimeInfo(
  runtimeInfo: AgentRuntimeInfo | undefined
): AgentRuntimeInfo | undefined {
  if (!runtimeInfo) {
    return undefined;
  }
  const sanitized: AgentRuntimeInfo = {
    provider: runtimeInfo.provider,
    sessionId: runtimeInfo.sessionId,
  };
  if (runtimeInfo.model !== undefined) {
    sanitized.model = runtimeInfo.model;
  }
  if (runtimeInfo.thinkingOptionId !== undefined) {
    sanitized.thinkingOptionId = runtimeInfo.thinkingOptionId;
  }
  if (runtimeInfo.modeId !== undefined) {
    sanitized.modeId = runtimeInfo.modeId;
  }
  const extra = sanitizeMetadata(runtimeInfo.extra);
  if (extra !== undefined) {
    sanitized.extra = extra;
  }
  return sanitized;
}

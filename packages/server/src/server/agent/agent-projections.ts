import type { AgentSnapshotPayload } from "../messages.js";
import type {
  SerializableAgentConfig,
  StoredAgentRecord,
} from "./agent-registry.js";
import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
  AgentUsage,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";

export type { ManagedAgent };

type ProjectionOptions = {
  title?: string | null;
  createdAt?: string;
};

export function toStoredAgentRecord(
  agent: ManagedAgent,
  options?: ProjectionOptions
): StoredAgentRecord {
  const createdAt = options?.createdAt ?? agent.createdAt.toISOString();
  const config = buildSerializableConfig(agent.config);
  const persistence = sanitizePersistenceHandle(agent.persistence);

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
    lastStatus: agent.lifecycle,
    lastModeId: agent.currentModeId ?? config?.modeId ?? null,
    config: config ?? null,
    persistence,
    requiresAttention: agent.attention.requiresAttention,
    attentionReason: agent.attention.requiresAttention
      ? agent.attention.attentionReason
      : null,
    attentionTimestamp: agent.attention.requiresAttention
      ? agent.attention.attentionTimestamp.toISOString()
      : null,
  } satisfies StoredAgentRecord;
}

export function toAgentPayload(
  agent: ManagedAgent,
  options?: ProjectionOptions
): AgentSnapshotPayload {
  const payload: AgentSnapshotPayload = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    model: agent.config.model ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt
      ? agent.lastUserMessageAt.toISOString()
      : null,
    status: agent.lifecycle,
    sessionId: agent.sessionId,
    capabilities: cloneCapabilities(agent.capabilities),
    currentModeId: agent.currentModeId,
    availableModes: cloneAvailableModes(agent.availableModes),
    pendingPermissions: sanitizePendingPermissions(agent.pendingPermissions),
    persistence: sanitizePersistenceHandle(agent.persistence),
    title: options?.title ?? null,
  };

  const usage = sanitizeOptionalJsonValue<AgentUsage>(agent.lastUsage);
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
  const extra = sanitizeOptionalJsonValue(config.extra);
  if (extra !== undefined) {
    serializable.extra = extra;
  }
  return Object.keys(serializable).length ? serializable : null;
}

function sanitizePendingPermissions(
  pending: Map<string, AgentPermissionRequest>
): AgentPermissionRequest[] {
  return Array.from(pending.values()).map((request) => (
    {
      ...request,
      input: sanitizeOptionalJsonValue(request.input),
      suggestions: sanitizeOptionalJsonValue(request.suggestions),
      metadata: sanitizeOptionalJsonValue(request.metadata),
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
  const metadata = sanitizeOptionalJsonValue(handle.metadata);
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

function sanitizeOptionalJson(value: unknown): unknown {
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
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeOptionalJson(val);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return Object.keys(result).length ? result : undefined;
  }
  return value;
}

function sanitizeOptionalJsonValue<T>(
  value: T | null | undefined
): T | undefined {
  const sanitized = sanitizeOptionalJson(value);
  return sanitized == null ? undefined : (sanitized as T);
}

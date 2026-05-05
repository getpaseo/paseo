import type {
  AgentListItemPayload,
  AgentSnapshotPayload,
  RecentProviderSessionDescriptorPayload,
} from "../messages.js";
import type { SerializableAgentConfig, StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentMetadata,
  AgentMode,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
  AgentRuntimeInfo,
  AgentTimelineItem,
  AgentUsage,
  PersistedAgentDescriptor,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { JsonValue } from "../json-utils.js";
import { isStoredAgentProviderAvailable, toAgentPersistenceHandle } from "../persistence-hooks.js";
export type { ManagedAgent };

interface ProjectionOptions {
  title?: string | null;
  createdAt?: string;
  internal?: boolean;
}

interface RecentProviderSessionProjectionOptions {
  providerLabel: string;
}

const PROMPT_PREVIEW_MAX_LENGTH = 160;

function normalizeThinkingOptionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeLabels(labels: Record<string, unknown> | undefined): Record<string, string> {
  if (!labels) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
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
  options?: ProjectionOptions,
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
    lastUserMessageAt: agent.lastUserMessageAt ? agent.lastUserMessageAt.toISOString() : null,
    title: options?.title ?? null,
    labels: agent.labels,
    lastStatus: agent.lifecycle,
    lastModeId: agent.currentModeId ?? config?.modeId ?? null,
    config: config ?? null,
    runtimeInfo,
    features: normalizeFeatures(agent.features),
    persistence,
    lastError: agent.lastError ?? undefined,
    requiresAttention: agent.attention.requiresAttention,
    attentionReason: agent.attention.requiresAttention ? agent.attention.attentionReason : null,
    attentionTimestamp: agent.attention.requiresAttention
      ? agent.attention.attentionTimestamp.toISOString()
      : null,
    internal: options?.internal,
  } satisfies StoredAgentRecord;
}

export function toAgentPayload(
  agent: ManagedAgent,
  options?: ProjectionOptions,
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
    ...(runtimeInfo ? { runtimeInfo } : {}),
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt ? agent.lastUserMessageAt.toISOString() : null,
    status: agent.lifecycle,
    capabilities: cloneCapabilities(agent.capabilities),
    currentModeId: agent.currentModeId,
    availableModes: cloneAvailableModes(agent.availableModes),
    features: normalizeFeatures(agent.features),
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

function buildStoredRuntimeInfo(record: StoredAgentRecord): AgentRuntimeInfo | undefined {
  if (!record.runtimeInfo) return undefined;
  const ri = record.runtimeInfo;
  const runtimeInfo: AgentRuntimeInfo = {
    provider: ri.provider,
    sessionId: ri.sessionId,
  };
  if (Object.prototype.hasOwnProperty.call(ri, "model")) {
    runtimeInfo.model = ri.model ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(ri, "thinkingOptionId")) {
    runtimeInfo.thinkingOptionId = ri.thinkingOptionId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(ri, "modeId")) {
    runtimeInfo.modeId = ri.modeId ?? null;
  }
  if (ri.extra) {
    runtimeInfo.extra = ri.extra;
  }
  return runtimeInfo;
}

function buildStoredPersistenceHandle(
  record: StoredAgentRecord,
  validProviders: Iterable<AgentProvider>,
): AgentPersistenceHandle | null {
  if (!isStoredAgentProviderAvailable(record, validProviders)) {
    return null;
  }
  return toAgentPersistenceHandle(validProviders, record.persistence);
}

export function buildStoredAgentPayload(
  record: StoredAgentRecord,
  validProviders: Iterable<AgentProvider>,
): AgentSnapshotPayload {
  const defaultCapabilities = {
    supportsStreaming: false,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
  } as const;

  const createdAt = new Date(record.createdAt);
  const updatedAt = new Date(resolveStoredAgentPayloadUpdatedAt(record));
  const lastUserMessageAt = record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null;

  const runtimeInfo = buildStoredRuntimeInfo(record);
  const providerAvailable = isStoredAgentProviderAvailable(record, validProviders);
  const persistence = buildStoredPersistenceHandle(record, validProviders);

  return {
    id: record.id,
    provider: record.provider,
    cwd: record.cwd,
    model: record.config?.model ?? null,
    thinkingOptionId: record.config?.thinkingOptionId ?? null,
    effectiveThinkingOptionId: resolveEffectiveThinkingOptionId({
      runtimeInfo,
      configuredThinkingOptionId: record.config?.thinkingOptionId ?? null,
    }),
    ...(runtimeInfo ? { runtimeInfo } : {}),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    lastUserMessageAt: lastUserMessageAt ? lastUserMessageAt.toISOString() : null,
    status: record.lastStatus,
    capabilities: defaultCapabilities,
    currentModeId: record.lastModeId ?? null,
    availableModes: [],
    pendingPermissions: [],
    persistence,
    title: record.title ?? record.config?.title ?? null,
    requiresAttention: record.requiresAttention ?? false,
    attentionReason: record.attentionReason ?? null,
    attentionTimestamp: record.attentionTimestamp ?? null,
    archivedAt: record.archivedAt ?? null,
    labels: normalizeLabels(record.labels),
    ...(providerAvailable ? {} : { providerUnavailable: true }),
  };
}

export function toAgentListItemPayload(agent: AgentSnapshotPayload): AgentListItemPayload {
  return {
    id: agent.id,
    shortId: agent.id.slice(0, 7),
    title: agent.title,
    provider: agent.provider,
    model: agent.runtimeInfo?.model ?? agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    effectiveThinkingOptionId: agent.effectiveThinkingOptionId,
    status: agent.status,
    cwd: agent.cwd,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    archivedAt: agent.archivedAt ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp ?? null,
    labels: agent.labels,
    ...(agent.providerUnavailable ? { providerUnavailable: true } : {}),
  };
}

export function toRecentProviderSessionDescriptorPayload(
  descriptor: PersistedAgentDescriptor,
  options: RecentProviderSessionProjectionOptions,
): RecentProviderSessionDescriptorPayload {
  const promptPreviews = collectPromptPreviews(descriptor.timeline);

  return {
    providerId: descriptor.provider,
    providerLabel: options.providerLabel,
    providerHandleId: descriptor.persistence.nativeHandle ?? descriptor.persistence.sessionId,
    cwd: descriptor.cwd,
    title: descriptor.title,
    firstPromptPreview: promptPreviews[0] ?? null,
    lastPromptPreview: promptPreviews.at(-1) ?? null,
    lastActivityAt: descriptor.lastActivityAt.toISOString(),
  };
}

export function resolveStoredAgentPayloadUpdatedAt(record: StoredAgentRecord): string {
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

function collectPromptPreviews(timeline: readonly AgentTimelineItem[]): string[] {
  return timeline.flatMap((item) => {
    if (item.type !== "user_message") {
      return [];
    }
    const preview = normalizePromptPreview(item.text);
    return preview ? [preview] : [];
  });
}

function normalizePromptPreview(text: string): string | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  return normalized.length > PROMPT_PREVIEW_MAX_LENGTH
    ? normalized.slice(0, PROMPT_PREVIEW_MAX_LENGTH)
    : normalized;
}

function buildSerializableConfig(config: AgentSessionConfig): SerializableAgentConfig | null {
  const serializable: SerializableAgentConfig = {};
  if (Object.prototype.hasOwnProperty.call(config, "title")) {
    serializable.title = config.title ?? null;
  }
  if (config.modeId) {
    serializable.modeId = config.modeId;
  }
  if (config.model) {
    serializable.model = config.model;
  }
  if (config.thinkingOptionId) {
    serializable.thinkingOptionId = config.thinkingOptionId;
  }
  if (Object.prototype.hasOwnProperty.call(config, "featureValues")) {
    const featureValues = sanitizeMetadata(config.featureValues);
    if (featureValues !== undefined) {
      serializable.featureValues = featureValues;
    }
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
  pending: Map<string, AgentPermissionRequest>,
): AgentPermissionRequest[] {
  return Array.from(pending.values()).map((request) =>
    Object.assign({}, request, {
      input: sanitizeMetadata(request.input),
      suggestions: sanitizeMetadataArray(request.suggestions),
      actions: request.actions?.map((action) => Object.assign({}, action)),
      metadata: sanitizeMetadata(request.metadata),
    }),
  );
}

function sanitizePersistenceHandle(
  handle: AgentPersistenceHandle | null,
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

function cloneCapabilities(capabilities: AgentCapabilityFlags): AgentCapabilityFlags {
  return { ...capabilities };
}

function cloneAvailableModes(modes: AgentMode[]): AgentMode[] {
  return modes.map((mode) => ({ ...mode }));
}

function normalizeFeatures(features: AgentFeature[] | null | undefined): AgentFeature[] {
  return Array.isArray(features) ? features.map((feature) => ({ ...feature })) : [];
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
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

type UsageNumericField = Exclude<keyof AgentUsage, never>;

function assignFiniteNumber(
  source: { [key: string]: JsonValue },
  target: AgentUsage,
  field: UsageNumericField,
): boolean {
  const raw = source[field];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    target[field] = raw;
    return true;
  }
  return raw === undefined || raw === null;
}

function sanitizeUsage(value: unknown): AgentUsage | undefined {
  const sanitized = sanitizeOptionalJson(value);
  if (!sanitized || !isJsonObject(sanitized)) {
    return undefined;
  }
  const result: AgentUsage = {};
  const fields: UsageNumericField[] = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "totalCostUsd",
    "contextWindowMaxTokens",
    "contextWindowUsedTokens",
  ];
  for (const field of fields) {
    if (!assignFiniteNumber(sanitized, result, field)) {
      return undefined;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeRuntimeInfo(
  runtimeInfo: AgentRuntimeInfo | undefined,
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

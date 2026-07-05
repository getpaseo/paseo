import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { normalizeAgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type {
  GetProvidersSnapshotResponseMessage,
  ListProviderModelsResponseMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

type ListProviderModelsPayload = ListProviderModelsResponseMessage["payload"];
type GetProvidersSnapshotPayload = GetProvidersSnapshotResponseMessage["payload"];
type ProvidersSnapshotUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];

// COMPAT(model-normalize): daemon normalizes at source (provider-registry) — shim covers older daemons; drop when floor >= v0.1.104
function normalizeAgentModels(
  models: AgentModelDefinition[] | undefined,
): AgentModelDefinition[] | undefined {
  if (!models) {
    return models;
  }

  let changed = false;
  const normalized = models.map((model) => {
    const next = normalizeAgentModelDefinition(model);
    changed ||= next !== model;
    return next;
  });

  return changed ? normalized : models;
}

function normalizeProviderSnapshotEntry(entry: ProviderSnapshotEntry): ProviderSnapshotEntry {
  const models = normalizeAgentModels(entry.models);
  return models === entry.models ? entry : { ...entry, models };
}

function normalizeProviderSnapshotEntries(
  entries: ProviderSnapshotEntry[],
): ProviderSnapshotEntry[] {
  let changed = false;
  const normalized = entries.map((entry) => {
    const next = normalizeProviderSnapshotEntry(entry);
    changed ||= next !== entry;
    return next;
  });

  return changed ? normalized : entries;
}

export function normalizeListProviderModelsPayload(
  payload: ListProviderModelsPayload,
): ListProviderModelsPayload {
  const models = normalizeAgentModels(payload.models);
  return models === payload.models ? payload : { ...payload, models };
}

export function normalizeProvidersSnapshotPayload<
  T extends GetProvidersSnapshotPayload | ProvidersSnapshotUpdatePayload,
>(payload: T): T {
  const entries = normalizeProviderSnapshotEntries(payload.entries);
  return entries === payload.entries ? payload : { ...payload, entries };
}

export function normalizeProviderSnapshotUpdateMessage(
  msg: SessionOutboundMessage,
): SessionOutboundMessage {
  if (msg.type !== "providers_snapshot_update") {
    return msg;
  }

  return { ...msg, payload: normalizeProvidersSnapshotPayload(msg.payload) };
}

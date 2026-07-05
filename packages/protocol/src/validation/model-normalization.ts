import {
  normalizeAgentModelDefinition,
  type AgentModelDefinition,
  type ProviderSnapshotEntry,
} from "../agent-types.js";
import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";

function normalizeModels(
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

function normalizeProviderEntries(entries: ProviderSnapshotEntry[]): ProviderSnapshotEntry[] {
  let changed = false;
  const normalized = entries.map((entry) => {
    const models = normalizeModels(entry.models);
    if (models === entry.models) {
      return entry;
    }

    changed = true;
    return { ...entry, models };
  });

  return changed ? normalized : entries;
}

export function normalizeSessionOutboundMessage(
  message: SessionOutboundMessage,
): SessionOutboundMessage {
  switch (message.type) {
    case "list_provider_models_response": {
      const models = normalizeModels(message.payload.models);
      return models === message.payload.models
        ? message
        : { ...message, payload: { ...message.payload, models } };
    }
    case "get_providers_snapshot_response": {
      const entries = normalizeProviderEntries(message.payload.entries);
      return entries === message.payload.entries
        ? message
        : { ...message, payload: { ...message.payload, entries } };
    }
    case "providers_snapshot_update": {
      const entries = normalizeProviderEntries(message.payload.entries);
      return entries === message.payload.entries
        ? message
        : { ...message, payload: { ...message.payload, entries } };
    }
    default:
      return message;
  }
}

export function normalizeWSOutboundMessage(message: WSOutboundMessage): WSOutboundMessage {
  if (message.type !== "session") {
    return message;
  }

  const normalized = normalizeSessionOutboundMessage(message.message);
  return normalized === message.message ? message : { ...message, message: normalized };
}

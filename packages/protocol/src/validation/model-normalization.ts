import {
  normalizeAgentModelDefinition,
  type AgentModelDefinition,
  type ProviderSnapshotEntry,
} from "../agent-types.js";
import type {
  MutableDaemonConfig,
  SessionOutboundMessage,
  WSOutboundMessage,
} from "../messages.js";

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

function normalizeProviderEntry(entry: ProviderSnapshotEntry): ProviderSnapshotEntry {
  const models = normalizeModels(entry.models);
  return models === entry.models ? entry : { ...entry, models };
}

function normalizeProviderEntries(entries: ProviderSnapshotEntry[]): ProviderSnapshotEntry[] {
  let changed = false;
  const normalized = entries.map((entry) => {
    const next = normalizeProviderEntry(entry);
    changed ||= next !== entry;
    return next;
  });

  return changed ? normalized : entries;
}

function normalizeMutableDaemonConfig(config: MutableDaemonConfig): MutableDaemonConfig {
  let next = config;
  const withPatch = (patch: Partial<MutableDaemonConfig>) => {
    next = next === config ? { ...config, ...patch } : { ...next, ...patch };
  };

  if (config.browserTools === undefined) {
    withPatch({ browserTools: { enabled: false } });
  } else if (config.browserTools.enabled === undefined) {
    withPatch({ browserTools: { ...config.browserTools, enabled: false } });
  }

  if (config.providers === undefined) {
    withPatch({ providers: {} });
  }

  if (config.metadataGeneration === undefined) {
    withPatch({ metadataGeneration: { providers: [] } });
  } else if (config.metadataGeneration.providers === undefined) {
    withPatch({
      metadataGeneration: { ...config.metadataGeneration, providers: [] },
    });
  }

  if (config.autoArchiveAfterMerge === undefined) {
    withPatch({ autoArchiveAfterMerge: false });
  }

  if (config.enableTerminalAgentHooks === undefined) {
    withPatch({ enableTerminalAgentHooks: false });
  }

  if (config.appendSystemPrompt === undefined) {
    withPatch({ appendSystemPrompt: "" });
  }

  return next;
}

export function normalizeSessionOutboundMessage(
  message: SessionOutboundMessage,
): SessionOutboundMessage {
  switch (message.type) {
    case "fetch_workspaces_response":
      return message.payload.emptyProjects === undefined
        ? { ...message, payload: { ...message.payload, emptyProjects: [] } }
        : message;
    case "get_daemon_config_response":
    case "set_daemon_config_response": {
      const config = normalizeMutableDaemonConfig(message.payload.config);
      return config === message.payload.config
        ? message
        : { ...message, payload: { ...message.payload, config } };
    }
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

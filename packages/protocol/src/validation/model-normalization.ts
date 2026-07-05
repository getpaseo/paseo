import {
  normalizeAgentModelDefinition,
  type AgentModelDefinition,
  type ProviderSnapshotEntry,
} from "../agent-types.js";
import type {
  MutableDaemonConfig,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WSOutboundMessage,
} from "../messages.js";

type FetchWorkspacesResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>;
type WorkspaceUpdateMessage = Extract<SessionOutboundMessage, { type: "workspace_update" }>;
type CheckoutPrStatusResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "checkout_pr_status_response" }
>;
type CheckoutPrStatus = NonNullable<CheckoutPrStatusResponseMessage["payload"]["status"]>;
type CheckoutPrGithubStatus = NonNullable<CheckoutPrStatus["github"]>;
type DirectorySuggestionsResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "directory_suggestions_response" }
>;

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
  let next = entry;
  if (entry.enabled === undefined) {
    next = { ...next, enabled: true };
  }
  if (models !== entry.models) {
    next = next === entry ? { ...entry, models } : { ...next, models };
  }

  return next;
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

function normalizeWorkspaceDescriptor(
  workspace: WorkspaceDescriptorPayload,
): WorkspaceDescriptorPayload {
  let next = workspace;
  const withPatch = (patch: Partial<WorkspaceDescriptorPayload>) => {
    next = next === workspace ? { ...workspace, ...patch } : { ...next, ...patch };
  };

  if (workspace.workspaceDirectory === undefined) {
    withPatch({ workspaceDirectory: workspace.projectRootPath });
  }

  if (workspace.archivingAt === undefined) {
    withPatch({ archivingAt: null });
  }

  if (workspace.statusEnteredAt === undefined) {
    withPatch({ statusEnteredAt: null });
  }

  if (workspace.scripts === undefined) {
    withPatch({ scripts: [] });
  }

  return next;
}

function normalizeWorkspaceDescriptors(
  entries: WorkspaceDescriptorPayload[],
): WorkspaceDescriptorPayload[] {
  let changed = false;
  const normalized = entries.map((entry) => {
    const next = normalizeWorkspaceDescriptor(entry);
    changed ||= next !== entry;
    return next;
  });

  return changed ? normalized : entries;
}

function normalizeFetchWorkspacesMessage(
  message: FetchWorkspacesResponseMessage,
): FetchWorkspacesResponseMessage {
  let next = message;
  const entries = normalizeWorkspaceDescriptors(message.payload.entries);
  if (entries !== message.payload.entries) {
    next = { ...next, payload: { ...next.payload, entries } };
  }

  if (message.payload.emptyProjects === undefined) {
    next = { ...next, payload: { ...next.payload, emptyProjects: [] } };
  }

  return next;
}

function normalizeWorkspaceUpdateMessage(message: WorkspaceUpdateMessage): WorkspaceUpdateMessage {
  if (message.payload.kind !== "upsert") {
    return message;
  }

  const workspace = normalizeWorkspaceDescriptor(message.payload.workspace);
  return workspace === message.payload.workspace
    ? message
    : { ...message, payload: { ...message.payload, workspace } };
}

function normalizeDirectorySuggestionsMessage(
  message: DirectorySuggestionsResponseMessage,
): DirectorySuggestionsResponseMessage {
  return message.payload.entries === undefined
    ? { ...message, payload: { ...message.payload, entries: [] } }
    : message;
}

const defaultCheckoutPrGithubRepository = {
  autoMergeAllowed: false,
  mergeCommitAllowed: false,
  squashMergeAllowed: false,
  rebaseMergeAllowed: false,
  viewerDefaultMergeMethod: null,
};

function normalizeCheckoutPrGithubRepository(repository: CheckoutPrGithubStatus["repository"]) {
  if (repository === undefined) {
    return defaultCheckoutPrGithubRepository;
  }

  const normalized = {
    autoMergeAllowed: repository.autoMergeAllowed ?? false,
    mergeCommitAllowed: repository.mergeCommitAllowed ?? false,
    squashMergeAllowed: repository.squashMergeAllowed ?? false,
    rebaseMergeAllowed: repository.rebaseMergeAllowed ?? false,
    viewerDefaultMergeMethod: repository.viewerDefaultMergeMethod ?? null,
  };

  return normalized.autoMergeAllowed === repository.autoMergeAllowed &&
    normalized.mergeCommitAllowed === repository.mergeCommitAllowed &&
    normalized.squashMergeAllowed === repository.squashMergeAllowed &&
    normalized.rebaseMergeAllowed === repository.rebaseMergeAllowed &&
    normalized.viewerDefaultMergeMethod === repository.viewerDefaultMergeMethod
    ? repository
    : normalized;
}

function normalizeCheckoutPrGithubStatus(github: CheckoutPrGithubStatus): CheckoutPrGithubStatus {
  const repository = normalizeCheckoutPrGithubRepository(github.repository);
  const normalized = {
    ...github,
    mergeStateStatus: github.mergeStateStatus ?? null,
    autoMergeRequest: github.autoMergeRequest ?? null,
    viewerCanEnableAutoMerge: github.viewerCanEnableAutoMerge ?? false,
    viewerCanDisableAutoMerge: github.viewerCanDisableAutoMerge ?? false,
    viewerCanMergeAsAdmin: github.viewerCanMergeAsAdmin ?? false,
    viewerCanUpdateBranch: github.viewerCanUpdateBranch ?? false,
    repository,
    isMergeQueueEnabled: github.isMergeQueueEnabled ?? false,
    isInMergeQueue: github.isInMergeQueue ?? false,
  };

  return normalized.mergeStateStatus === github.mergeStateStatus &&
    normalized.autoMergeRequest === github.autoMergeRequest &&
    normalized.viewerCanEnableAutoMerge === github.viewerCanEnableAutoMerge &&
    normalized.viewerCanDisableAutoMerge === github.viewerCanDisableAutoMerge &&
    normalized.viewerCanMergeAsAdmin === github.viewerCanMergeAsAdmin &&
    normalized.viewerCanUpdateBranch === github.viewerCanUpdateBranch &&
    normalized.repository === github.repository &&
    normalized.isMergeQueueEnabled === github.isMergeQueueEnabled &&
    normalized.isInMergeQueue === github.isInMergeQueue
    ? github
    : normalized;
}

function normalizeCheckoutPrStatus(status: CheckoutPrStatus): CheckoutPrStatus {
  const github =
    status.github === undefined ? undefined : normalizeCheckoutPrGithubStatus(status.github);
  const normalized = {
    ...status,
    isDraft: status.isDraft ?? false,
    mergeable: status.mergeable ?? "UNKNOWN",
    checks: status.checks ?? [],
    github,
  };

  return normalized.isDraft === status.isDraft &&
    normalized.mergeable === status.mergeable &&
    normalized.checks === status.checks &&
    normalized.github === status.github
    ? status
    : normalized;
}

function normalizeCheckoutPrStatusMessage(
  message: CheckoutPrStatusResponseMessage,
): CheckoutPrStatusResponseMessage {
  const status = message.payload.status;
  if (!status) {
    return message;
  }

  const normalized = normalizeCheckoutPrStatus(status);
  return normalized === status
    ? message
    : { ...message, payload: { ...message.payload, status: normalized } };
}

export function normalizeSessionOutboundMessage(
  message: SessionOutboundMessage,
): SessionOutboundMessage {
  switch (message.type) {
    case "fetch_workspaces_response":
      return normalizeFetchWorkspacesMessage(message);
    case "workspace_update":
      return normalizeWorkspaceUpdateMessage(message);
    case "directory_suggestions_response":
      return normalizeDirectorySuggestionsMessage(message);
    case "checkout_pr_status_response":
      return normalizeCheckoutPrStatusMessage(message);
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

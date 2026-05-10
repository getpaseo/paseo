import type { z } from "zod";
import type { Logger } from "pino";
import type { ProviderDefinition } from "./provider-registry.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
  AgentTimelineItem,
  PersistedAgentDescriptor,
} from "./agent-sdk-types.js";
import { scheduleAgentMetadataGeneration } from "./agent-metadata-generator.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import { unarchiveAgentState } from "./agent-prompt.js";
import { toRecentProviderSessionDescriptorPayload } from "./agent-projections.js";
import type {
  FetchRecentProviderSessionsRequestMessage,
  ImportAgentRequestMessageSchema,
  RecentProviderSessionDescriptorPayload,
} from "../../shared/messages.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";

type ImportAgentRequestMessage = z.infer<typeof ImportAgentRequestMessageSchema>;

const METADATA_GENERATION_PROMPT_PREFIX =
  "Generate metadata for a coding agent based on the user prompt.";

export interface NormalizedImportAgentRequest {
  provider: string;
  providerHandleId: string;
  cwd?: string;
  labels?: Record<string, string>;
  requestId: string;
}

export class ImportSessionsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportSessionsRequestError";
  }
}

export interface ListImportableProviderSessionsInput {
  request: FetchRecentProviderSessionsRequestMessage;
  agentManager: Pick<AgentManager, "listAgents" | "listImportablePersistedAgents">;
  agentStorage: Pick<AgentStorage, "list">;
  providerRegistry: Record<string, Pick<ProviderDefinition, "label"> | undefined>;
}

export interface ListImportableProviderSessionsResult {
  entries: RecentProviderSessionDescriptorPayload[];
  filteredAlreadyImportedCount: number;
}

export interface ImportProviderSessionInput {
  request: NormalizedImportAgentRequest;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  paseoHome?: string;
  logger: Logger;
  deps?: {
    scheduleAgentMetadataGeneration?: typeof scheduleAgentMetadataGeneration;
  };
}

export interface ImportProviderSessionResult {
  snapshot: ManagedAgent;
  timelineSize: number;
}

// COMPAT(import-agent-request-v1): accept legacy {provider, sessionId} shape
// alongside the new {providerId, providerHandleId} shape. Old clients
// (< target daemon floor) send the legacy fields. Drop the fallbacks and the
// .optional() in messages.ts when the supported client floor is >= the daemon
// version that ships the new shape (target: 2026-11-08).
export function normalizeImportAgentRequest(
  msg: ImportAgentRequestMessage,
): NormalizedImportAgentRequest | { error: string } {
  const provider = msg.providerId ?? msg.provider;
  const providerHandleId = msg.providerHandleId ?? msg.sessionId;
  if (!provider || !providerHandleId) {
    return { error: "Import requires providerId and providerHandleId" };
  }
  return {
    provider,
    providerHandleId,
    cwd: msg.cwd,
    labels: msg.labels,
    requestId: msg.requestId,
  };
}

export async function listImportableProviderSessions(
  input: ListImportableProviderSessionsInput,
): Promise<ListImportableProviderSessionsResult> {
  const { request, agentManager, agentStorage, providerRegistry } = input;
  const limit = request.limit ?? 20;
  const sinceTimestamp = parseRecentProviderSessionsSince(request.since);
  const providerFilter = request.providers ? new Set(request.providers) : undefined;
  const importedHandles = await collectImportedProviderSessionHandles(agentManager, agentStorage);

  const descriptors = await agentManager.listImportablePersistedAgents({
    limit: 200,
    providerFilter,
    cwd: request.cwd,
  });
  let filteredAlreadyImportedCount = 0;
  const candidates: PersistedAgentDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (request.cwd && descriptor.cwd !== request.cwd) {
      continue;
    }
    if (sinceTimestamp !== null && descriptor.lastActivityAt.getTime() < sinceTimestamp) {
      continue;
    }
    if (isMetadataGenerationDescriptor(descriptor)) {
      continue;
    }
    const providerHandleId =
      descriptor.persistence.nativeHandle ?? descriptor.persistence.sessionId;
    if (importedHandles.has(toProviderSessionHandleKey(descriptor.provider, providerHandleId))) {
      filteredAlreadyImportedCount += 1;
      continue;
    }
    candidates.push(descriptor);
  }

  const entries = candidates
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .slice(0, limit)
    .map((descriptor) =>
      toRecentProviderSessionDescriptorPayload(descriptor, {
        providerLabel: providerRegistry[descriptor.provider]?.label ?? descriptor.provider,
      }),
    );

  return { entries, filteredAlreadyImportedCount };
}

export async function importProviderSession(
  input: ImportProviderSessionInput,
): Promise<ImportProviderSessionResult> {
  const { provider, providerHandleId, cwd, labels } = input.request;
  const descriptor = await input.agentManager.findPersistedAgent(provider, providerHandleId);
  if (!descriptor && provider === "opencode" && !cwd) {
    throw new Error(
      "OpenCode sessions require --cwd when the session cannot be found in persisted agents",
    );
  }

  const handle = descriptor
    ? applyImportCwdOverride(descriptor.persistence, cwd)
    : buildImportPersistenceHandle({ provider, providerHandleId, cwd });
  const overrides = cwd ? ({ cwd } satisfies Partial<AgentSessionConfig>) : undefined;

  await unarchiveAgentByHandle(input.agentStorage, input.agentManager, handle);
  const snapshot = await input.agentManager.resumeAgentFromPersistence(
    handle,
    overrides,
    undefined,
    {
      labels,
    },
  );
  await unarchiveAgentState(input.agentStorage, input.agentManager, snapshot.id);
  await input.agentManager.hydrateTimelineFromProvider(snapshot.id);
  await applyImportedAgentTitle({
    snapshot,
    agentManager: input.agentManager,
    workspaceGitService: input.workspaceGitService,
    paseoHome: input.paseoHome,
    logger: input.logger,
    scheduleAgentMetadataGeneration:
      input.deps?.scheduleAgentMetadataGeneration ?? scheduleAgentMetadataGeneration,
  });

  return {
    snapshot,
    timelineSize: input.agentManager.getTimeline(snapshot.id).length,
  };
}

async function unarchiveAgentByHandle(
  agentStorage: AgentStorage,
  agentManager: AgentManager,
  handle: AgentPersistenceHandle,
): Promise<void> {
  const records = await agentStorage.list();
  const matched = records.find(
    (record) =>
      record.persistence?.provider === handle.provider &&
      record.persistence?.sessionId === handle.sessionId,
  );
  if (!matched) {
    return;
  }
  await unarchiveAgentState(agentStorage, agentManager, matched.id);
}

async function applyImportedAgentTitle(input: {
  snapshot: ManagedAgent;
  agentManager: AgentManager;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  paseoHome?: string;
  logger: Logger;
  scheduleAgentMetadataGeneration: typeof scheduleAgentMetadataGeneration;
}): Promise<void> {
  const initialPrompt = getFirstUserMessageText(input.agentManager.getTimeline(input.snapshot.id));
  if (!initialPrompt) {
    return;
  }

  const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
    configTitle: input.snapshot.config.title,
    initialPrompt,
  });
  if (!explicitTitle && provisionalTitle) {
    await input.agentManager.setTitle(input.snapshot.id, provisionalTitle);
  }

  input.scheduleAgentMetadataGeneration({
    agentManager: input.agentManager,
    agentId: input.snapshot.id,
    cwd: input.snapshot.cwd,
    workspaceGitService: input.workspaceGitService,
    initialPrompt,
    explicitTitle,
    paseoHome: input.paseoHome,
    logger: input.logger,
  });
}

function parseRecentProviderSessionsSince(since: string | undefined): number | null {
  if (!since) {
    return null;
  }
  const timestamp = Date.parse(since);
  if (Number.isNaN(timestamp)) {
    throw new ImportSessionsRequestError("invalid_since", "Invalid recent provider sessions since");
  }
  return timestamp;
}

function buildImportPersistenceHandle(input: {
  provider: AgentProvider;
  providerHandleId: string;
  cwd?: string;
}): AgentPersistenceHandle {
  const cwd = input.cwd ?? process.cwd();
  return {
    provider: input.provider,
    sessionId: input.providerHandleId,
    nativeHandle: input.providerHandleId,
    metadata: {
      provider: input.provider,
      cwd,
    },
  };
}

function applyImportCwdOverride(
  handle: AgentPersistenceHandle,
  cwd: string | undefined,
): AgentPersistenceHandle {
  if (!cwd) {
    return handle;
  }

  return {
    ...handle,
    metadata: {
      ...handle.metadata,
      provider: handle.provider,
      cwd,
    },
  };
}

function getFirstUserMessageText(timeline: readonly AgentTimelineItem[]): string | null {
  for (const item of timeline) {
    if (item.type !== "user_message") {
      continue;
    }
    const text = item.text.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

async function collectImportedProviderSessionHandles(
  agentManager: Pick<AgentManager, "listAgents">,
  agentStorage: Pick<AgentStorage, "list">,
): Promise<Set<string>> {
  const handles = new Set<string>();

  for (const agent of agentManager.listAgents()) {
    collectProviderSessionHandleKeys(handles, agent.provider, agent.persistence);
  }

  for (const record of await agentStorage.list()) {
    collectProviderSessionHandleKeys(handles, record.provider, record.persistence);
  }

  return handles;
}

function toProviderSessionHandleKey(provider: string, providerHandleId: string): string {
  return `${provider}\0${providerHandleId}`;
}

function isMetadataGenerationDescriptor(descriptor: PersistedAgentDescriptor): boolean {
  for (const item of descriptor.timeline) {
    if (item.type !== "user_message") continue;
    return item.text.trimStart().startsWith(METADATA_GENERATION_PROMPT_PREFIX);
  }
  return false;
}

function collectProviderSessionHandleKeys(
  target: Set<string>,
  provider: AgentProvider | StoredAgentRecord["provider"] | string,
  persistence: AgentPersistenceHandle | null | undefined,
): void {
  if (!persistence) {
    return;
  }

  target.add(toProviderSessionHandleKey(provider, persistence.sessionId));
  if (persistence.nativeHandle) {
    target.add(toProviderSessionHandleKey(provider, persistence.nativeHandle));
  }
}

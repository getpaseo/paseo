import type { z } from "zod";
import type { ProviderDefinition } from "./provider-registry.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  PersistedAgentDescriptor,
} from "./agent-sdk-types.js";
import { toRecentProviderSessionDescriptorPayload } from "./agent-projections.js";
import type {
  FetchRecentProviderSessionsRequestMessage,
  ImportAgentRequestMessageSchema,
  RecentProviderSessionDescriptorPayload,
} from "../../shared/messages.js";

type ImportAgentRequestMessage = z.infer<typeof ImportAgentRequestMessageSchema>;

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

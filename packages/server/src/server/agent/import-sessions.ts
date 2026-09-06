import type { z } from "zod";
import type { Logger } from "pino";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import type {
  AgentManager,
  ManagedAgent,
  ManagedImportableProviderSession,
} from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentPersistenceHandle, AgentProvider } from "./agent-sdk-types.js";
import { ensureAgentLoaded, type AgentLoaderManager } from "./agent-loading.js";
import { unarchiveAgentState } from "./agent-prompt.js";
import { toRecentProviderSessionDescriptorPayload } from "./agent-projections.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type {
  FetchRecentProviderSessionsRequestMessage,
  ImportAgentRequestMessageSchema,
  ProviderSessionContinueRequestMessage,
  RecentProviderSessionDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createRealpathAwarePathMatcher } from "../../utils/path.js";

type ImportAgentRequestMessage = z.infer<typeof ImportAgentRequestMessageSchema>;

const METADATA_GENERATION_PROMPT_PREFIX =
  "Generate metadata for a coding agent based on the user prompt.";
const IMPORT_SESSION_SEARCH_SCAN_LIMIT = 500;
export type ImportSessionAgentManager = AgentLoaderManager &
  Pick<
    AgentManager,
    | "archiveSnapshot"
    | "closeAgent"
    | "getTimeline"
    | "importProviderSession"
    | "notifyAgentState"
    | "unarchiveSnapshot"
  >;

export type ContinueProviderSessionAgentManager = Pick<
  AgentManager,
  "continueProviderSession" | "getTimeline"
>;

const providerSessionImportMutations = new WeakMap<object, Map<string, Promise<unknown>>>();

export interface NormalizedImportAgentRequest {
  provider: AgentProvider;
  providerHandleId: string;
  cwd?: string;
  workspaceId?: string;
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
  agentManager: Pick<AgentManager, "listAgents" | "listImportableSessions">;
  agentStorage: Pick<AgentStorage, "list">;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "getProviderLabel">;
  workspaceGitService?: Pick<WorkspaceGitService, "getSnapshot">;
}

export interface ListImportableProviderSessionsResult {
  entries: RecentProviderSessionDescriptorPayload[];
  filteredAlreadyImportedCount: number;
  providerErrors: Array<{ provider: string; message: string }>;
}

export interface ImportProviderSessionInput {
  request: NormalizedImportAgentRequest;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  agentManager: ImportSessionAgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

export interface ImportProviderSessionResult {
  snapshot: ManagedAgent;
  timelineSize: number;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

export interface ContinueProviderSessionInput {
  request: ProviderSessionContinueRequestMessage;
  destinationCwd: string;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  agentManager: ContinueProviderSessionAgentManager;
}

interface ImportedProviderSession {
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
    provider: provider as AgentProvider,
    providerHandleId,
    cwd: msg.cwd,
    workspaceId: msg.workspaceId,
    labels: msg.labels,
    requestId: msg.requestId,
  };
}

export async function listImportableProviderSessions(
  input: ListImportableProviderSessionsInput,
): Promise<ListImportableProviderSessionsResult> {
  const { request, agentManager, agentStorage, providerSnapshotManager, workspaceGitService } =
    input;
  if (request.cwd && request.targetCwd) {
    throw new ImportSessionsRequestError(
      "conflicting_cwds",
      "Recent provider session listing accepts either cwd or targetCwd, not both",
    );
  }
  const limit = request.limit ?? 20;
  const sinceTimestamp = parseRecentProviderSessionsSince(request.since);
  const providerFilter = request.providers ? new Set(request.providers) : undefined;
  const importedSessions = await collectImportedProviderSessions(
    agentManager,
    agentStorage,
    providerFilter,
  );
  const importedHandles = importedSessions.handles;
  const query = normalizeImportSessionQuery(request.query);
  const targetCwd = request.targetCwd;
  const targetRepository = targetCwd
    ? await resolveContinueRepositoryIdentity(workspaceGitService, targetCwd)
    : null;
  // Continuing in another worktree needs enough source rows to filter by a
  // local Git identity after provider discovery. A normal resume listing keeps
  // its existing tight limit.
  let listingLimit = limit + importedSessions.count;
  if (query) {
    listingLimit = IMPORT_SESSION_SEARCH_SCAN_LIMIT;
  } else if (targetCwd) {
    listingLimit = Math.min(Math.max(limit * 5, 50) + importedSessions.count, 200);
  }

  const listing = await agentManager.listImportableSessions({
    limit: listingLimit,
    ...(query ? { query } : {}),
    ...(query ? { scanLimit: IMPORT_SESSION_SEARCH_SCAN_LIMIT } : {}),
    providerFilter,
    cwd: request.cwd,
  });
  const { candidates, filteredAlreadyImportedCount } = await filterImportableProviderSessions({
    sessions: listing.sessions,
    requestCwd: request.cwd,
    targetCwd,
    targetRepository,
    workspaceGitService,
    sinceTimestamp,
    importedHandles,
  });

  const entries = candidates
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .slice(0, limit)
    .map((descriptor) =>
      toRecentProviderSessionDescriptorPayload(descriptor, {
        providerLabel: providerSnapshotManager.getProviderLabel(descriptor.provider),
      }),
    );

  return {
    entries,
    filteredAlreadyImportedCount,
    providerErrors: listing.providerErrors,
  };
}

function normalizeImportSessionQuery(query: string | undefined): string | null {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : null;
}

async function filterImportableProviderSessions(input: {
  sessions: ManagedImportableProviderSession[];
  requestCwd: string | undefined;
  targetCwd: string | undefined;
  targetRepository: string | null;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot"> | undefined;
  sinceTimestamp: number | null;
  importedHandles: ReadonlySet<string>;
}): Promise<{
  candidates: Array<ManagedImportableProviderSession & { isTargetCwd?: boolean }>;
  filteredAlreadyImportedCount: number;
}> {
  const matchesRequestCwd = input.requestCwd
    ? createRealpathAwarePathMatcher(input.requestCwd)
    : null;
  const matchesTargetCwd = input.targetCwd ? createRealpathAwarePathMatcher(input.targetCwd) : null;
  const matchesTargetRepository = input.targetRepository
    ? createRealpathAwarePathMatcher(input.targetRepository)
    : null;
  const sourceRepositoryByCwd = new Map<string, Promise<string | null>>();
  const candidates: Array<ManagedImportableProviderSession & { isTargetCwd?: boolean }> = [];
  let filteredAlreadyImportedCount = 0;

  for (const session of input.sessions) {
    if (matchesRequestCwd && !matchesRequestCwd(session.cwd)) {
      continue;
    }
    const isTargetCwd = matchesTargetCwd?.(session.cwd) ?? false;
    if (
      input.targetCwd &&
      !isTargetCwd &&
      !(await isSameTargetRepository({
        sessionCwd: session.cwd,
        targetCwd: input.targetCwd,
        matchesTargetRepository,
        workspaceGitService: input.workspaceGitService,
        sourceRepositoryByCwd,
      }))
    ) {
      continue;
    }
    if (
      (input.sinceTimestamp !== null && session.lastActivityAt.getTime() < input.sinceTimestamp) ||
      isMetadataGenerationSession(session)
    ) {
      continue;
    }
    if (
      input.importedHandles.has(
        toProviderSessionHandleKey(session.provider, session.providerHandleId),
      )
    ) {
      filteredAlreadyImportedCount += 1;
      continue;
    }
    candidates.push({ ...session, ...(input.targetCwd ? { isTargetCwd } : {}) });
  }

  return { candidates, filteredAlreadyImportedCount };
}

async function isSameTargetRepository(input: {
  sessionCwd: string;
  targetCwd: string | undefined;
  matchesTargetRepository: ((cwd: string) => boolean) | null;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot"> | undefined;
  sourceRepositoryByCwd: Map<string, Promise<string | null>>;
}): Promise<boolean> {
  if (!input.targetCwd || !input.matchesTargetRepository) {
    return false;
  }
  let sourceRepository = input.sourceRepositoryByCwd.get(input.sessionCwd);
  if (!sourceRepository) {
    sourceRepository = resolveContinueRepositoryIdentity(
      input.workspaceGitService,
      input.sessionCwd,
    );
    input.sourceRepositoryByCwd.set(input.sessionCwd, sourceRepository);
  }
  const sourceRepositoryValue = await sourceRepository;
  return sourceRepositoryValue !== null && input.matchesTargetRepository(sourceRepositoryValue);
}

export async function importProviderSession(
  input: ImportProviderSessionInput,
): Promise<ImportProviderSessionResult> {
  const cwd = input.request.cwd;
  if (!cwd) {
    throw new Error("Import requires cwd from the selected provider session");
  }
  const key = await resolveProviderSessionImportMutationKey(input);
  return serializeProviderSessionImport(input.agentManager, key, async () => {
    const placement = await input.workspaceProvisioning.runInImportWorkspace(
      { cwd, requestedWorkspaceId: input.request.workspaceId },
      (workspace) => importProviderSessionNow(input, cwd, workspace.workspaceId),
    );
    return { ...placement.value, createdWorkspace: placement.createdWorkspace };
  });
}

/**
 * Continue an importable provider session in an existing Paseo workspace.
 *
 * This path has deliberately different ownership from importProviderSession:
 * it asks the provider for a new native handle, then registers that handle in
 * the destination workspace. It never adopts, closes, or edits the source
 * provider session or its working tree.
 */
export async function continueProviderSession(
  input: ContinueProviderSessionInput,
): Promise<ImportProviderSessionResult> {
  const { request, destinationCwd } = input;
  if (createRealpathAwarePathMatcher(request.sourceCwd)(destinationCwd)) {
    throw new ImportSessionsRequestError(
      "same_cwd",
      "Continue here needs a different workspace. Resume the original session instead.",
    );
  }
  await assertContinueHereRepositoryMatch({
    workspaceGitService: input.workspaceGitService,
    sourceCwd: request.sourceCwd,
    destinationCwd,
  });

  const key = `continue\0${toProviderSessionHandleKey(request.providerId, request.providerHandleId)}`;
  return serializeProviderSessionImport(input.agentManager, key, async () => {
    const placement = await input.workspaceProvisioning.runInImportWorkspace(
      { cwd: destinationCwd, requestedWorkspaceId: request.workspaceId },
      async (workspace) => {
        const snapshot = await input.agentManager.continueProviderSession({
          provider: request.providerId as AgentProvider,
          providerHandleId: request.providerHandleId,
          sourceCwd: request.sourceCwd,
          destinationCwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
        });
        return {
          snapshot,
          timelineSize: input.agentManager.getTimeline(snapshot.id).length,
        };
      },
    );
    return { ...placement.value, createdWorkspace: placement.createdWorkspace };
  });
}

async function importProviderSessionNow(
  input: ImportProviderSessionInput,
  cwd: string,
  workspaceId: string,
): Promise<ImportedProviderSession> {
  const { provider, providerHandleId, labels } = input.request;

  const matchingRecords = await input.agentStorage.listByProviderSession(
    provider,
    providerHandleId,
  );
  const activeRecord = matchingRecords.find((record) => !record.archivedAt);
  if (activeRecord) {
    throw new Error(`Provider session is already imported: ${providerHandleId}`);
  }
  const archivedRecord = matchingRecords.find((record) => record.archivedAt);
  if (archivedRecord?.persistence && archivedRecord.archivedAt) {
    if (!createRealpathAwarePathMatcher(cwd)(archivedRecord.cwd)) {
      throw new Error(`Provider session cwd does not match import cwd: ${providerHandleId}`);
    }
    const requestedParentAgentId = getParentAgentIdFromLabels(input.request.labels);
    const labelPatch: Record<string, string | null> = { ...input.request.labels };
    if (
      Object.hasOwn(archivedRecord.labels, PARENT_AGENT_ID_LABEL) ||
      Object.hasOwn(input.request.labels ?? {}, PARENT_AGENT_ID_LABEL)
    ) {
      labelPatch[PARENT_AGENT_ID_LABEL] = requestedParentAgentId;
    }
    await unarchiveAgentState(input.agentStorage, input.agentManager, archivedRecord.id, {
      workspaceId,
      labels: Object.keys(labelPatch).length > 0 ? labelPatch : undefined,
    });
    try {
      const snapshot = await ensureAgentLoaded(archivedRecord.id, {
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        logger: input.logger,
      });
      return {
        snapshot,
        timelineSize: input.agentManager.getTimeline(snapshot.id).length,
      };
    } catch (error) {
      await rollbackArchivedImport(input, archivedRecord, archivedRecord.archivedAt);
      throw error;
    }
  }

  const snapshot = await input.agentManager.importProviderSession({
    provider,
    providerHandleId,
    cwd,
    workspaceId,
    labels,
  });
  await unarchiveAgentState(input.agentStorage, input.agentManager, snapshot.id);

  return {
    snapshot,
    timelineSize: input.agentManager.getTimeline(snapshot.id).length,
  };
}

async function serializeProviderSessionImport<T>(
  agentManager: object,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let mutations = providerSessionImportMutations.get(agentManager);
  if (!mutations) {
    mutations = new Map();
    providerSessionImportMutations.set(agentManager, mutations);
  }

  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  mutations.set(key, next);
  try {
    return await next;
  } finally {
    if (mutations.get(key) === next) {
      mutations.delete(key);
    }
  }
}

async function resolveProviderSessionImportMutationKey(
  input: ImportProviderSessionInput,
): Promise<string> {
  const matchingRecord = (
    await input.agentStorage.listByProviderSession(
      input.request.provider,
      input.request.providerHandleId,
    )
  ).at(0);
  return matchingRecord
    ? `agent\0${matchingRecord.id}`
    : `handle\0${toProviderSessionHandleKey(
        input.request.provider,
        input.request.providerHandleId,
      )}`;
}

async function rollbackArchivedImport(
  input: ImportProviderSessionInput,
  archivedRecord: StoredAgentRecord,
  archivedAt: string,
): Promise<void> {
  try {
    if (input.agentManager.getAgent(archivedRecord.id)) {
      await input.agentManager.closeAgent(archivedRecord.id);
    }
    await input.agentManager.archiveSnapshot(archivedRecord.id, archivedAt);
  } catch (error) {
    input.logger.error(
      { err: error, agentId: archivedRecord.id },
      "Failed to re-archive provider session after import failure",
    );
  }

  try {
    await input.agentStorage.upsert(archivedRecord);
  } catch (error) {
    input.logger.error(
      { err: error, agentId: archivedRecord.id },
      "Failed to restore archived agent record after import failure",
    );
  }
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

async function assertContinueHereRepositoryMatch(input: {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  sourceCwd: string;
  destinationCwd: string;
}): Promise<void> {
  const [sourceRepository, destinationRepository] = await Promise.all([
    resolveContinueRepositoryIdentity(input.workspaceGitService, input.sourceCwd),
    resolveContinueRepositoryIdentity(input.workspaceGitService, input.destinationCwd),
  ]);
  if (
    !sourceRepository ||
    !destinationRepository ||
    !createRealpathAwarePathMatcher(sourceRepository)(destinationRepository)
  ) {
    throw new ImportSessionsRequestError(
      "different_repository",
      "Continue here requires source and destination workspaces from the same local Git repository.",
    );
  }
}

/**
 * Git worktrees have distinct repo roots but share a common main checkout.
 * Prefer that common root when the Git service knows it so Continue here can
 * safely span manually-created and Paseo-created worktrees alike.
 */
async function resolveContinueRepositoryIdentity(
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot"> | undefined,
  cwd: string,
): Promise<string | null> {
  if (!workspaceGitService) {
    return null;
  }
  try {
    const snapshot = await workspaceGitService.getSnapshot(cwd);
    if (!snapshot.git.isGit) {
      return null;
    }
    return snapshot.git.mainRepoRoot ?? snapshot.git.repoRoot;
  } catch {
    return null;
  }
}

async function collectImportedProviderSessions(
  agentManager: Pick<AgentManager, "listAgents">,
  agentStorage: Pick<AgentStorage, "list">,
  providerFilter: Set<string> | undefined,
): Promise<{ handles: Set<string>; count: number }> {
  const handles = new Set<string>();
  const sessions = new Set<string>();
  const records = await agentStorage.list();
  const storedRecordsById = new Map(records.map((record) => [record.id, record]));

  const collect = (
    provider: AgentProvider | StoredAgentRecord["provider"] | string,
    persistence: AgentPersistenceHandle | null | undefined,
  ) => {
    if (!persistence || (providerFilter && !providerFilter.has(provider))) return;
    sessions.add(toProviderSessionHandleKey(provider, persistence.sessionId));
    collectProviderSessionHandleKeys(handles, provider, persistence);
  };

  for (const agent of agentManager.listAgents()) {
    if (storedRecordsById.get(agent.id)?.archivedAt) {
      continue;
    }
    collect(agent.provider, agent.persistence);
  }

  for (const record of records) {
    if (record.archivedAt) {
      continue;
    }
    collect(record.provider, record.persistence);
  }

  return { handles, count: sessions.size };
}

function toProviderSessionHandleKey(provider: string, providerHandleId: string): string {
  return `${provider}\0${providerHandleId}`;
}

function isMetadataGenerationSession(input: { firstPromptPreview: string | null }): boolean {
  return (
    input.firstPromptPreview?.trimStart().startsWith(METADATA_GENERATION_PROMPT_PREFIX) ?? false
  );
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

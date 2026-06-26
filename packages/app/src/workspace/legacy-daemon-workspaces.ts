import type {
  DaemonClient,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import {
  deriveAgentStateBucket,
  getWorkspaceStateBucketPriority,
} from "@getpaseo/protocol/agent-state-bucket";
import type { Agent, DaemonServerInfo, WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildAgentDirectoryState,
  replaceFetchedAgentDirectory,
} from "@/utils/agent-directory-sync";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export interface LegacyDaemonWorkspaceSnapshot {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
}

export interface LegacyDaemonWorkspaceFetchResult extends LegacyDaemonWorkspaceSnapshot {
  subscriptionId: string | null;
}

interface LegacyDaemonWorkspaceDirectoryReadResult {
  entries: FetchAgentsEntry[];
  subscriptionId: string | null;
}

interface LegacyDaemonWorkspaceBackfillInput {
  client: Pick<DaemonClient, "fetchAgents">;
  serverId: string;
  workspaces: ReadonlyMap<unknown, unknown>;
  emptyProjects: ReadonlyMap<unknown, unknown>;
  isCancelled?: () => boolean;
}

const LEGACY_AGENT_DIRECTORY_SORT: NonNullable<FetchAgentsOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

// COMPAT(legacyWorkspaceDaemon): v0.1.97 app talking to <=v0.1.96 daemons.
// Older daemons expose agents by cwd but may have no workspace registry rows.
// Keep all cwd -> synthetic workspace behavior in this file so the shim is
// deleted by removing this module and its call sites once the daemon floor is v0.1.97.
export function buildLegacyDaemonWorkspaceSnapshot(input: {
  serverId: string;
  entries: FetchAgentsEntry[];
}): LegacyDaemonWorkspaceSnapshot {
  const entries = stampLegacyWorkspaceIds(input.entries);
  const { agents } = buildAgentDirectoryState({
    serverId: input.serverId,
    entries,
  });

  return {
    agents,
    workspaces: buildLegacyWorkspaces(entries),
  };
}

export function shouldUseLegacyDaemonWorkspaceDirectory(
  serverInfo: DaemonServerInfo | null | undefined,
): boolean {
  return (
    serverInfo !== null &&
    serverInfo !== undefined &&
    serverInfo.features?.workspaceMultiplicity !== true
  );
}

function shouldBackfillLegacyDaemonWorkspaceDirectory(
  serverInfo: DaemonServerInfo | null | undefined,
): boolean {
  return serverInfo?.features?.workspaceMultiplicity !== true;
}

export async function fetchLegacyDaemonWorkspaceDirectory(input: {
  client: Pick<DaemonClient, "fetchAgents">;
  serverId: string;
  subscribe?: FetchAgentsOptions["subscribe"];
  page?: FetchAgentsOptions["page"];
}): Promise<LegacyDaemonWorkspaceFetchResult> {
  const directory = await readLegacyDaemonWorkspaceDirectory(input);
  if (!directory) {
    throw new Error("Legacy daemon workspace directory fetch was cancelled.");
  }
  const snapshot = replaceLegacyDaemonWorkspaceDirectory({
    serverId: input.serverId,
    entries: directory.entries,
  });
  return { ...snapshot, subscriptionId: directory.subscriptionId };
}

export async function backfillLegacyDaemonWorkspaceDirectoryIfEmpty(
  input: LegacyDaemonWorkspaceBackfillInput,
): Promise<boolean> {
  if (input.workspaces.size > 0 || input.emptyProjects.size > 0) {
    return false;
  }
  const serverInfo = useSessionStore.getState().sessions[input.serverId]?.serverInfo;
  if (!shouldBackfillLegacyDaemonWorkspaceDirectory(serverInfo)) {
    return false;
  }
  if (input.isCancelled?.()) {
    return true;
  }
  const directory = await readLegacyDaemonWorkspaceDirectory({
    client: input.client,
    isCancelled: input.isCancelled,
  });
  if (!directory || input.isCancelled?.()) {
    return true;
  }
  replaceLegacyDaemonWorkspaceDirectory({
    serverId: input.serverId,
    entries: directory.entries,
  });
  return true;
}

async function readLegacyDaemonWorkspaceDirectory(input: {
  client: Pick<DaemonClient, "fetchAgents">;
  subscribe?: FetchAgentsOptions["subscribe"];
  page?: FetchAgentsOptions["page"];
  isCancelled?: () => boolean;
}): Promise<LegacyDaemonWorkspaceDirectoryReadResult | null> {
  const entries: FetchAgentsEntry[] = [];
  let cursor = input.page?.cursor ?? null;
  let includeSubscribe = true;
  let subscriptionId: string | null = null;
  const pageLimit = input.page?.limit ?? 200;

  while (true) {
    if (input.isCancelled?.()) {
      return null;
    }

    const payload = await input.client.fetchAgents({
      sort: LEGACY_AGENT_DIRECTORY_SORT,
      ...(includeSubscribe && input.subscribe ? { subscribe: input.subscribe } : {}),
      page: cursor ? { limit: pageLimit, cursor } : { limit: pageLimit },
    });
    if (input.isCancelled?.()) {
      return null;
    }

    entries.push(...payload.entries);
    subscriptionId = subscriptionId ?? payload.subscriptionId ?? null;
    includeSubscribe = false;
    if (!readFetchAgentsHasMore(payload.pageInfo)) {
      break;
    }
    const nextCursor = readFetchAgentsNextCursor(payload.pageInfo);
    if (!nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  return { entries, subscriptionId };
}

export function applyLegacyDaemonWorkspaceOwnership(input: {
  serverId: string;
  agent: Agent;
}): Agent {
  if (input.agent.workspaceId) {
    return input.agent;
  }

  const session = useSessionStore.getState().sessions[input.serverId];
  if (!shouldBackfillLegacyDaemonWorkspaceDirectory(session?.serverInfo)) {
    return input.agent;
  }

  const existingAgent =
    session?.agents.get(input.agent.id) ?? session?.agentDetails.get(input.agent.id) ?? null;
  const workspaceId =
    existingAgent?.workspaceId ??
    resolveLegacyWorkspaceIdFromAgent(input.agent, session?.workspaces) ??
    null;
  if (!workspaceId) {
    return input.agent;
  }

  return {
    ...input.agent,
    workspaceId,
    projectPlacement: input.agent.projectPlacement ?? existingAgent?.projectPlacement,
  };
}

function replaceLegacyDaemonWorkspaceDirectory(input: {
  serverId: string;
  entries: FetchAgentsEntry[];
}): LegacyDaemonWorkspaceSnapshot {
  const entries = stampLegacyWorkspaceIds(input.entries);
  const { agents } = replaceFetchedAgentDirectory({
    serverId: input.serverId,
    entries,
  });
  const workspaces = buildLegacyWorkspaces(entries);
  const store = useSessionStore.getState();
  store.setWorkspaces(input.serverId, workspaces);
  store.setEmptyProjects(input.serverId, []);
  store.setHasHydratedWorkspaces(input.serverId, true);
  return { agents, workspaces };
}

function readFetchAgentsHasMore(
  pageInfo: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"],
): boolean {
  const page = pageInfo as {
    hasMore?: boolean;
    hasMoreAfter?: boolean;
  };
  if (typeof page.hasMore === "boolean") {
    return page.hasMore;
  }
  if (typeof page.hasMoreAfter === "boolean") {
    return page.hasMoreAfter;
  }
  return false;
}

function readFetchAgentsNextCursor(
  pageInfo: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"],
): string | null {
  const page = pageInfo as {
    nextCursor?: string | null;
    afterCursor?: string | null;
  };
  if (typeof page.nextCursor === "string") {
    return page.nextCursor;
  }
  if (typeof page.afterCursor === "string") {
    return page.afterCursor;
  }
  return null;
}

function stampLegacyWorkspaceIds(entries: FetchAgentsEntry[]): FetchAgentsEntry[] {
  return entries.map((entry) => {
    const workspaceId = resolveLegacyWorkspaceId(entry);
    return {
      ...entry,
      agent: {
        ...entry.agent,
        workspaceId,
      },
    };
  });
}

function buildLegacyWorkspaces(entries: FetchAgentsEntry[]): Map<string, WorkspaceDescriptor> {
  const workspaces = new Map<string, WorkspaceDescriptor>();
  for (const entry of entries) {
    const workspaceId = entry.agent.workspaceId ?? resolveLegacyWorkspaceId(entry);
    const status = deriveAgentStateBucket({
      status: entry.agent.status,
      pendingPermissionCount: entry.agent.pendingPermissions.length,
      requiresAttention: entry.agent.requiresAttention,
      attentionReason: entry.agent.attentionReason,
    });
    const statusEnteredAt = parseLegacyAgentTimestamp(entry);
    const existing = workspaces.get(workspaceId);
    if (!existing) {
      workspaces.set(workspaceId, createLegacyWorkspace(entry, status, statusEnteredAt));
      continue;
    }
    if (
      getWorkspaceStateBucketPriority(status) < getWorkspaceStateBucketPriority(existing.status)
    ) {
      workspaces.set(workspaceId, {
        ...existing,
        status,
        statusEnteredAt,
      });
    }
  }
  return workspaces;
}

function createLegacyWorkspace(
  entry: FetchAgentsEntry,
  status: WorkspaceDescriptor["status"],
  statusEnteredAt: Date | null,
): WorkspaceDescriptor {
  const workspaceDirectory = resolveLegacyWorkspaceId(entry);
  const checkout = entry.project.checkout;
  const projectRootPath =
    normalizeWorkspacePath(checkout.mainRepoRoot ?? checkout.worktreeRoot ?? checkout.cwd) ??
    workspaceDirectory;
  return {
    id: workspaceDirectory,
    projectId: entry.project.projectKey,
    projectDisplayName: entry.project.projectName,
    projectCustomName: null,
    projectRootPath,
    workspaceDirectory,
    projectKind: checkout.isGit ? "git" : "non_git",
    workspaceKind: resolveLegacyWorkspaceKind(checkout),
    name: resolveLegacyWorkspaceName(entry, workspaceDirectory),
    title: null,
    status,
    statusEnteredAt,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: checkout.isGit
      ? {
          currentBranch: checkout.currentBranch,
          remoteUrl: checkout.remoteUrl,
          isPaseoOwnedWorktree: checkout.isPaseoOwnedWorktree,
          isDirty: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
        }
      : null,
    githubRuntime: null,
    project: entry.project,
  };
}

function resolveLegacyWorkspaceKind(
  checkout: FetchAgentsEntry["project"]["checkout"],
): WorkspaceDescriptor["workspaceKind"] {
  if (!checkout.isGit) {
    return "directory";
  }
  if (checkout.isPaseoOwnedWorktree) {
    return "worktree";
  }
  return "checkout";
}

function resolveLegacyWorkspaceId(entry: FetchAgentsEntry): string {
  return (
    normalizeWorkspacePath(entry.project.checkout.cwd) ??
    normalizeWorkspacePath(entry.agent.cwd) ??
    entry.agent.cwd
  );
}

function resolveLegacyWorkspaceIdFromAgent(
  agent: Agent,
  workspaces: Map<string, WorkspaceDescriptor> | undefined,
): string | null {
  const cwd = normalizeWorkspacePath(agent.cwd);
  if (!cwd) {
    return null;
  }

  for (const workspace of workspaces?.values() ?? []) {
    if (normalizeWorkspacePath(workspace.workspaceDirectory) === cwd) {
      return workspace.id;
    }
  }

  return cwd;
}

function resolveLegacyWorkspaceName(entry: FetchAgentsEntry, workspaceDirectory: string): string {
  const explicitName = entry.project.workspaceName?.trim();
  if (explicitName) {
    return explicitName;
  }
  const branchName = entry.project.checkout.currentBranch?.trim();
  if (branchName && branchName !== "HEAD") {
    return branchName;
  }
  return workspaceDirectoryName(workspaceDirectory);
}

function workspaceDirectoryName(directory: string): string {
  const trimmed = directory.trim().replace(/[/]+$/g, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

function parseLegacyAgentTimestamp(entry: FetchAgentsEntry): Date | null {
  const value = entry.agent.attentionTimestamp ?? entry.agent.updatedAt;
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

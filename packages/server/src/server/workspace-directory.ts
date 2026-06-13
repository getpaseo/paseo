import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type pino from "pino";
import type {
  AgentSnapshotPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
} from "./messages.js";
import {
  deriveAgentStateBucket,
  getWorkspaceStateBucketPriority,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels, isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { SortablePager } from "./pagination/sortable-pager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { resolveActiveWorkspaceRecordForCwd } from "./workspace-registry-model.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";

type WorkspaceIdResolver = (cwd: string) => string | undefined;

const FETCH_WORKSPACES_SORT_KEYS = [
  "status_priority",
  "activity_at",
  "name",
  "project_id",
] as const;

/**
 * Per-workspace bucket history. Drives the priority-unmasking semantic for
 * `statusEnteredAt`: when the winning bucket changes from a higher-priority
 * mask to a lower-priority bucket, the new entry time is the unmask time
 * (i.e., the moment the higher-priority bucket cleared), not when the
 * underlying agent originally entered the lower-priority bucket. Cleared when
 * the workspace has never had contributing agents.
 */
interface WorkspaceBucketHistoryEntry {
  bucket: WorkspaceStateBucket;
  enteredAt: string;
}

type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type FetchWorkspacesRequestSort = NonNullable<FetchWorkspacesRequestMessage["sort"]>[number];
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];

export type WorkspaceUpdatesFilter = FetchWorkspacesRequestFilter;

export function resolveRegisteredWorkspaceIdForCwd(
  cwd: string,
  workspaces: PersistedWorkspaceRecord[],
): string | null {
  const resolvedCwd = resolve(cwd);
  const exact = workspaces.find((workspace) => workspace.cwd === resolvedCwd);
  if (exact) {
    return exact.workspaceId;
  }

  const userHome = homedir();
  let bestMatch: PersistedWorkspaceRecord | null = null;
  for (const workspace of workspaces) {
    if (workspace.cwd === userHome) continue;
    if (workspace.archivedAt) continue;
    const prefix = workspace.cwd.endsWith(sep) ? workspace.cwd : `${workspace.cwd}${sep}`;
    if (!resolvedCwd.startsWith(prefix)) {
      continue;
    }
    if (!bestMatch || workspace.cwd.length > bestMatch.cwd.length) {
      bestMatch = workspace;
    }
  }

  return bestMatch?.workspaceId ?? null;
}

export interface WorkspaceDirectoryDeps {
  logger: pino.Logger;
  projectRegistry: {
    list(): Promise<PersistedProjectRecord[]>;
  };
  workspaceRegistry: {
    list(): Promise<PersistedWorkspaceRecord[]>;
  };
  listAgentPayloads(): Promise<AgentSnapshotPayload[]>;
  listTerminalActivityContributions(): Promise<
    Array<{ cwd: string; activity: TerminalActivity | null }>
  >;
  isProviderVisibleToClient(provider: string): boolean;
  buildWorkspaceDescriptor(input: {
    workspace: PersistedWorkspaceRecord;
    projectRecord?: PersistedProjectRecord | null;
    includeGitData: boolean;
  }): Promise<WorkspaceDescriptorPayload>;
}

export function summarizeFetchWorkspacesEntries(entries: Iterable<FetchWorkspacesResponseEntry>): {
  count: number;
  projectIds: string[];
  statusCounts: Record<string, number>;
  workspaces: Array<{
    id: string;
    projectId: string;
    projectDisplayName: string;
    name: string;
    status: FetchWorkspacesResponseEntry["status"];
    workspaceKind: FetchWorkspacesResponseEntry["workspaceKind"];
    activityAt: string | null;
  }>;
} {
  const workspaces = Array.from(entries, (entry) => ({
    id: entry.id,
    projectId: entry.projectId,
    projectDisplayName: entry.projectDisplayName,
    name: entry.name,
    status: entry.status,
    workspaceKind: entry.workspaceKind,
    activityAt: entry.activityAt,
  }));
  const statusCounts = new Map<string, number>();
  for (const workspace of workspaces) {
    statusCounts.set(workspace.status, (statusCounts.get(workspace.status) ?? 0) + 1);
  }

  return {
    count: workspaces.length,
    projectIds: [...new Set(workspaces.map((workspace) => workspace.projectId))],
    statusCounts: Object.fromEntries(statusCounts),
    workspaces,
  };
}

export class WorkspaceDirectory {
  private readonly archivingByWorkspaceId = new Map<string, string>();
  /**
   * Per-workspace last-seen winning bucket + entered-at. Persists across
   * `buildDescriptorMap` calls inside the daemon process; reset on cold start.
   * Server-internal; never crosses the wire.
   */
  private readonly bucketHistoryByWorkspaceId = new Map<string, WorkspaceBucketHistoryEntry>();

  private readonly pager = new SortablePager<
    WorkspaceDescriptorPayload,
    FetchWorkspacesRequestSort["key"]
  >({
    validKeys: FETCH_WORKSPACES_SORT_KEYS,
    defaultSort: [{ key: "activity_at", direction: "desc" }],
    label: "fetch_workspaces",
    getId: (workspace) => workspace.id,
    getSortValue: (workspace, key) => {
      switch (key) {
        case "status_priority":
          return getWorkspaceStateBucketPriority(workspace.status);
        case "activity_at":
          return workspace.activityAt ? Date.parse(workspace.activityAt) : null;
        case "name":
          return workspace.name.toLocaleLowerCase();
        case "project_id":
          return workspace.projectId.toLocaleLowerCase();
        default:
          throw new Error("unreachable");
      }
    },
  });

  constructor(private readonly deps: WorkspaceDirectoryDeps) {}

  markArchiving(workspaceIds: Iterable<string>, archivingAt: string): void {
    for (const workspaceId of workspaceIds) {
      this.archivingByWorkspaceId.set(workspaceId, archivingAt);
    }
  }

  clearArchiving(workspaceIds: Iterable<string>): void {
    for (const workspaceId of workspaceIds) {
      this.archivingByWorkspaceId.delete(workspaceId);
    }
  }

  async buildDescriptorMap(options: {
    includeGitData: boolean;
    workspaceIds?: Iterable<string>;
  }): Promise<Map<string, WorkspaceDescriptorPayload>> {
    const [agents, persistedWorkspaces, persistedProjects, terminalContributions] =
      await Promise.all([
        this.deps.listAgentPayloads(),
        this.deps.workspaceRegistry.list(),
        this.deps.projectRegistry.list(),
        this.deps.listTerminalActivityContributions(),
      ]);

    const activeProjects = new Map(
      persistedProjects
        .filter((project) => !project.archivedAt)
        .map((project) => [project.projectId, project] as const),
    );
    const archivedProjectIds = new Set(
      persistedProjects.filter((project) => project.archivedAt).map((project) => project.projectId),
    );
    const activeRecords = persistedWorkspaces.filter(
      (workspace) => !workspace.archivedAt && !archivedProjectIds.has(workspace.projectId),
    );
    const descriptorsByWorkspaceId = new Map<string, WorkspaceDescriptorPayload>();
    const workspaceIds = options.workspaceIds ? new Set(options.workspaceIds) : null;
    const workspaceIdsByDirectory = new Map(
      activeRecords.map((workspace) => [resolve(workspace.cwd), workspace.workspaceId] as const),
    );
    const resolveActiveWorkspaceIdForCwd: WorkspaceIdResolver = (cwd) =>
      resolveActiveWorkspaceRecordForCwd(cwd, activeRecords)?.workspaceId;

    const includedWorkspaces = activeRecords.filter(
      (workspace) => !workspaceIds || workspaceIds.has(workspace.workspaceId),
    );
    const workspaceDescriptors = await Promise.all(
      includedWorkspaces.map((workspace) =>
        this.deps.buildWorkspaceDescriptor({
          workspace,
          projectRecord: activeProjects.get(workspace.projectId) ?? null,
          includeGitData: options.includeGitData,
        }),
      ),
    );
    for (let i = 0; i < includedWorkspaces.length; i += 1) {
      const workspaceId = includedWorkspaces[i].workspaceId;
      descriptorsByWorkspaceId.set(workspaceId, {
        ...workspaceDescriptors[i],
        archivingAt: this.archivingByWorkspaceId.get(workspaceId) ?? null,
      });
    }

    const activeAgents = agents.filter(
      (agent) => !agent.archivedAt && this.deps.isProviderVisibleToClient(agent.provider),
    );
    const activeAgentsById = new Map(activeAgents.map((agent) => [agent.id, agent] as const));

    for (const agent of activeAgents) {
      let workspaceAgent = agent;
      let bucket: WorkspaceDescriptorPayload["status"];
      if (isDelegatedAgent(agent)) {
        if (agent.status !== "running") {
          continue;
        }
        const parentAgent = resolveDelegationRootAgent(agent, activeAgentsById);
        if (!parentAgent) {
          continue;
        }
        workspaceAgent = parentAgent;
        bucket = "running";
      } else {
        bucket = deriveAgentStateBucket({
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason ?? null,
        });
      }

      const workspaceId = workspaceIdsByDirectory.get(resolve(workspaceAgent.cwd));
      if (workspaceId === undefined) {
        continue;
      }
      const existing = descriptorsByWorkspaceId.get(workspaceId);
      if (!existing) {
        continue;
      }

      if (
        getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(existing.status)
      ) {
        existing.status = bucket;
      }
    }

    // Terminal activity contributions: working terminal → running bucket.
    const terminalEntriesByWorkspaceId = this.applyTerminalContributions(
      terminalContributions,
      resolveActiveWorkspaceIdForCwd,
      descriptorsByWorkspaceId,
    );

    // Resolve the workspace-level `statusEnteredAt` (see aggregate semantics
    // on `resolveStatusEnteredAt`).
    const nowIso = new Date().toISOString();
    for (const [workspaceId, descriptor] of descriptorsByWorkspaceId) {
      const contributingAgents = agents.filter(
        (agent) =>
          !agent.archivedAt &&
          this.deps.isProviderVisibleToClient(agent.provider) &&
          workspaceIdsByDirectory.get(resolve(agent.cwd)) === workspaceId,
      );
      const terminalEntries = terminalEntriesByWorkspaceId.get(workspaceId) ?? [];
      const result = this.resolveStatusEnteredAt({
        workspaceId,
        winningBucket: descriptor.status,
        contributingAgents,
        terminalEntries,
        previous: this.bucketHistoryByWorkspaceId.get(workspaceId) ?? null,
        nowIso,
      });
      descriptor.statusEnteredAt = result.statusEnteredAt;
      if (result.recordUpdate) {
        this.bucketHistoryByWorkspaceId.set(workspaceId, result.recordUpdate);
      } else if (result.recordDelete) {
        this.bucketHistoryByWorkspaceId.delete(workspaceId);
      }
    }

    return descriptorsByWorkspaceId;
  }

  // Apply working terminal contributions to descriptor statuses and build a map
  // of terminal timestamp entries per workspace for use in `resolveStatusEnteredAt`.
  private applyTerminalContributions(
    terminalContributions: Array<{ cwd: string; activity: TerminalActivity | null }>,
    resolveWorkspaceIdForCwd: WorkspaceIdResolver,
    descriptorsByWorkspaceId: Map<string, WorkspaceDescriptorPayload>,
  ): Map<string, Array<{ bucket: WorkspaceStateBucket; changedAtIso: string }>> {
    const terminalEntriesByWorkspaceId = new Map<
      string,
      Array<{ bucket: WorkspaceStateBucket; changedAtIso: string }>
    >();
    for (const { cwd, activity } of terminalContributions) {
      if (!activity) {
        continue;
      }
      let bucket: WorkspaceStateBucket;
      if (activity.state === "working") {
        bucket = "running";
      } else if (activity.state === "attention") {
        bucket = "needs_input";
      } else {
        continue;
      }
      const workspaceId = resolveWorkspaceIdForCwd(cwd);
      if (workspaceId === undefined) {
        continue;
      }
      const existing = descriptorsByWorkspaceId.get(workspaceId);
      if (!existing) {
        continue;
      }
      if (
        getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(existing.status)
      ) {
        existing.status = bucket;
      }
      const entries = terminalEntriesByWorkspaceId.get(workspaceId) ?? [];
      entries.push({ bucket, changedAtIso: new Date(activity.changedAt).toISOString() });
      terminalEntriesByWorkspaceId.set(workspaceId, entries);
    }
    return terminalEntriesByWorkspaceId;
  }

  // Aggregate the workspace-level `statusEnteredAt` from its contributing
  // agents and terminals. Aggregate semantics:
  //   - winning bucket = highest-priority across contributing agents and terminals;
  //   - entry time = best-effort timestamp from agents/terminals in the winning bucket;
  //   - priority unmasking: when the winning bucket transitions (e.g. a
  //     higher-priority bucket cleared), the new entry time is "now";
  //   - same-bucket emits reuse the previous entered-at;
  //   - empty workspaces that never had contributing agents or terminals get
  //     `statusEnteredAt: null`.
  //   - when archived agents leave a previously active workspace empty, keep
  //     the previous done timestamp or stamp the transition to done now.
  private resolveStatusEnteredAt(params: {
    workspaceId: string;
    winningBucket: WorkspaceStateBucket;
    contributingAgents: AgentSnapshotPayload[];
    terminalEntries: Array<{ bucket: WorkspaceStateBucket; changedAtIso: string }>;
    previous: WorkspaceBucketHistoryEntry | null;
    nowIso: string;
  }): {
    statusEnteredAt: string | null;
    recordUpdate?: WorkspaceBucketHistoryEntry;
    recordDelete?: true;
  } {
    const { winningBucket, contributingAgents, terminalEntries, previous, nowIso } = params;

    if (contributingAgents.length === 0 && terminalEntries.length === 0) {
      if (!previous) {
        return { statusEnteredAt: null };
      }

      const enteredAt = previous.bucket === "done" ? previous.enteredAt : nowIso;
      return {
        statusEnteredAt: enteredAt,
        recordUpdate: { bucket: "done", enteredAt },
      };
    }

    if (!previous) {
      const newestInWinningBucket = this.findNewestTimestampInBucket(
        contributingAgents,
        terminalEntries,
        winningBucket,
      );
      const enteredAt = newestInWinningBucket ?? nowIso;
      return {
        statusEnteredAt: enteredAt,
        recordUpdate: { bucket: winningBucket, enteredAt },
      };
    }

    if (previous.bucket !== winningBucket) {
      return {
        statusEnteredAt: nowIso,
        recordUpdate: { bucket: winningBucket, enteredAt: nowIso },
      };
    }

    return {
      statusEnteredAt: previous.enteredAt,
      recordUpdate: previous,
    };
  }

  // Best-effort newest timestamp across contributing agents and terminal entries
  // whose bucket matches `winningBucket`. For agents, uses:
  //   - `attentionTimestamp` when attention is set (covers attention/failed)
  //   - `updatedAt` as a general fallback for any bucket
  // Returns `null` if no matching contributor has a parseable timestamp.
  private findNewestTimestampInBucket(
    contributingAgents: AgentSnapshotPayload[],
    terminalEntries: Array<{ bucket: WorkspaceStateBucket; changedAtIso: string }>,
    winningBucket: WorkspaceStateBucket,
  ): string | null {
    const agentTimestamps = contributingAgents
      .filter((agent) => {
        const derived = deriveAgentStateBucket({
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason ?? null,
        });
        return derived === winningBucket;
      })
      .map((agent) => {
        // Prefer attentionTimestamp when the agent has attention set — this is
        // the most accurate "entered current status" signal.
        if (agent.attentionTimestamp) {
          return agent.attentionTimestamp;
        }
        // Fall back to updatedAt as a general proxy for recent activity.
        return agent.updatedAt;
      })
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    const terminalTimestamps = terminalEntries
      .filter((entry) => entry.bucket === winningBucket)
      .map((entry) => entry.changedAtIso);

    const candidates = [...agentTimestamps, ...terminalTimestamps].sort();
    return candidates.at(-1) ?? null;
  }

  resolveRegisteredWorkspaceIdForCwd(
    cwd: string,
    workspaces: PersistedWorkspaceRecord[],
  ): string | null {
    return resolveRegisteredWorkspaceIdForCwd(cwd, workspaces);
  }

  async listDescriptors(): Promise<WorkspaceDescriptorPayload[]> {
    return Array.from(
      (
        await this.buildDescriptorMap({
          includeGitData: true,
        })
      ).values(),
    );
  }

  matchesFilter(input: {
    workspace: WorkspaceDescriptorPayload;
    filter: FetchWorkspacesRequestFilter | undefined;
  }): boolean {
    const { workspace, filter } = input;
    if (!filter) {
      return true;
    }

    if (filter.projectId && filter.projectId.trim().length > 0) {
      if (workspace.projectId !== filter.projectId.trim()) {
        return false;
      }
    }

    if (filter.query && filter.query.trim().length > 0) {
      const query = filter.query.trim().toLocaleLowerCase();
      const haystacks = [workspace.name, workspace.projectId, workspace.id];
      if (!haystacks.some((value) => value.toLocaleLowerCase().includes(query))) {
        return false;
      }
    }

    return true;
  }

  async listFetchEntries(request: FetchWorkspacesRequestMessage): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }> {
    const filter = request.filter;
    const sort = this.pager.normalizeSort(request.sort);
    let entries = await this.listDescriptors();
    const listedCount = entries.length;
    entries = entries.filter((workspace) => this.matchesFilter({ workspace, filter }));
    const filteredCount = entries.length;
    entries.sort((left, right) => this.pager.compare(left, right, sort));

    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.pager.decode(cursorToken, sort);
      entries = entries.filter(
        (workspace) => this.pager.compareWithCursor(workspace, cursor, sort) > 0,
      );
    }

    const limit = request.page?.limit ?? 200;
    const pagedEntries = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.pager.encode(pagedEntries[pagedEntries.length - 1], sort)
        : null;

    this.deps.logger.debug(
      {
        requestId: request.requestId,
        filter: request.filter ?? null,
        sort,
        page: request.page ?? null,
        listedCount,
        filteredCount,
        returnedCount: pagedEntries.length,
        hasMore,
        nextCursor,
      },
      "fetch_workspaces_entries_listed",
    );

    return {
      entries: pagedEntries,
      pageInfo: {
        nextCursor,
        prevCursor: request.page?.cursor ?? null,
        hasMore,
      },
    };
  }
}

function resolveDelegationRootAgent(
  agent: AgentSnapshotPayload,
  activeAgentsById: ReadonlyMap<string, AgentSnapshotPayload>,
): AgentSnapshotPayload | null {
  const seen = new Set<string>([agent.id]);
  let current = agent;

  while (true) {
    const parentAgentId = getParentAgentIdFromLabels(current.labels);
    if (!parentAgentId) {
      return current;
    }
    if (seen.has(parentAgentId)) {
      return null;
    }
    const parent = activeAgentsById.get(parentAgentId);
    if (!parent) {
      return null;
    }
    seen.add(parentAgentId);
    current = parent;
  }
}

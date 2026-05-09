import { homedir } from "node:os";
import { sep } from "node:path";
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
} from "../shared/agent-state-bucket.js";
import { SortablePager } from "./pagination/sortable-pager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { normalizeWorkspaceId } from "./workspace-registry-model.js";

const FETCH_WORKSPACES_SORT_KEYS = [
  "status_priority",
  "activity_at",
  "name",
  "project_id",
] as const;

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

export interface WorkspaceDirectoryDeps {
  logger: pino.Logger;
  projectRegistry: {
    list(): Promise<PersistedProjectRecord[]>;
  };
  workspaceRegistry: {
    list(): Promise<PersistedWorkspaceRecord[]>;
  };
  listAgentPayloads(): Promise<AgentSnapshotPayload[]>;
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
    const [agents, persistedWorkspaces, persistedProjects] = await Promise.all([
      this.deps.listAgentPayloads(),
      this.deps.workspaceRegistry.list(),
      this.deps.projectRegistry.list(),
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
      activeRecords.map(
        (workspace) => [normalizeWorkspaceId(workspace.cwd), workspace.workspaceId] as const,
      ),
    );

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

    for (const agent of agents) {
      if (agent.archivedAt) {
        continue;
      }
      if (!this.deps.isProviderVisibleToClient(agent.provider)) {
        continue;
      }

      const workspaceId = workspaceIdsByDirectory.get(normalizeWorkspaceId(agent.cwd));
      if (workspaceId === undefined) {
        continue;
      }
      const existing = descriptorsByWorkspaceId.get(workspaceId);
      if (!existing) {
        continue;
      }

      const bucket = deriveAgentStateBucket({
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason ?? null,
      });
      if (
        getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(existing.status)
      ) {
        existing.status = bucket;
      }
    }

    return descriptorsByWorkspaceId;
  }

  resolveRegisteredWorkspaceIdForCwd(cwd: string, workspaces: PersistedWorkspaceRecord[]): string {
    const normalizedCwd = normalizeWorkspaceId(cwd);
    const exact = workspaces.find((workspace) => workspace.cwd === normalizedCwd);
    if (exact) {
      return exact.workspaceId;
    }

    const userHome = homedir();
    let bestMatch: PersistedWorkspaceRecord | null = null;
    for (const workspace of workspaces) {
      if (workspace.cwd === userHome) continue;
      if (workspace.archivedAt) continue;
      const prefix = workspace.cwd.endsWith(sep) ? workspace.cwd : `${workspace.cwd}${sep}`;
      if (!normalizedCwd.startsWith(prefix)) {
        continue;
      }
      if (!bestMatch || workspace.cwd.length > bestMatch.cwd.length) {
        bestMatch = workspace;
      }
    }

    return bestMatch?.workspaceId ?? normalizedCwd;
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

    if (filter.idPrefix && filter.idPrefix.trim().length > 0) {
      if (!workspace.id.startsWith(filter.idPrefix.trim())) {
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

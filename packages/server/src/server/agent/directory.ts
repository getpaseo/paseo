import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload } from "../messages.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

/**
 * Which background agents a discovery read admits. An agent is effectively background when
 * it or its workspace is background.
 * - `false`: none, the default for lists.
 * - `true`: all of them.
 * - `"workspaces"`: only agents in background workspaces.
 *   COMPAT(backgroundAgents): added in v0.15.0, remove after 2027-05-03 once client floor
 *   >= v0.15.0. Inclusive reads from sources without `background_agents` use it: older apps
 *   replicate inclusively and auto-open a tab for every root agent.
 */
export type BackgroundVisibility = boolean | "workspaces";

interface DiscoverableAgent {
  workspaceId?: string;
  internal?: boolean;
  background?: boolean;
  labels?: Record<string, string>;
}

/**
 * One discovery match before projection. Paging reads sort and cursor on these, and only the
 * page's worth of them becomes an `AgentSnapshotPayload`.
 */
export type AgentDirectoryCandidate =
  | { kind: "live"; agent: ManagedAgent; record: StoredAgentRecord | null }
  | { kind: "stored"; record: StoredAgentRecord };

export interface AgentDirectoryFilter {
  workspaceIds?: Iterable<string>;
  /** Include parent chains by ID for workspace root classification. */
  includeAncestors?: boolean;
  labels?: Record<string, string>;
  includeArchived?: boolean;
  includeBackground?: BackgroundVisibility;
  includeUnavailablePersisted?: boolean;
}

/** Public agent discovery owns background visibility for live and durable records. */
export class AgentDirectory {
  constructor(
    private readonly deps: {
      manager: Pick<AgentManager, "listAgents">;
      storage: Pick<
        AgentStorage,
        "get" | "listActive" | "listByWorkspaces" | "lastUserMessageAtByWorkspace"
      >;
      workspaces: Pick<WorkspaceRegistry, "get">;
      projectLive(agent: ManagedAgent): Promise<AgentSnapshotPayload>;
      projectStored(record: StoredAgentRecord): AgentSnapshotPayload;
      isProviderVisible(provider: string): boolean;
      isStoredProviderAvailable(record: StoredAgentRecord): boolean;
    },
  ) {}

  /** Human prompt recency includes archived/unavailable agents without projecting their UI payloads. */
  async workspaceLastUserMessageTimes(
    workspaceIds?: Iterable<string>,
  ): Promise<Map<string, string>> {
    const requested = workspaceIds ? new Set(workspaceIds) : undefined;
    const live = this.deps.manager.listAgents();
    const times = new Map(
      await this.deps.storage.lastUserMessageAtByWorkspace(requested, {
        excludeAgentIds: live.map((agent) => agent.id),
      }),
    );
    for (const agent of live) {
      if (agent.internal || agent.background || !agent.workspaceId || !agent.lastUserMessageAt)
        continue;
      if (requested && !requested.has(agent.workspaceId)) continue;
      const at = agent.lastUserMessageAt.toISOString();
      if (at > (times.get(agent.workspaceId) ?? "")) times.set(agent.workspaceId, at);
    }
    return times;
  }

  async includes(
    agent: DiscoverableAgent,
    visibility: BackgroundVisibility = false,
  ): Promise<boolean> {
    const workspace = agent.workspaceId ? await this.deps.workspaces.get(agent.workspaceId) : null;
    return admits(agent, workspace?.background === true, visibility);
  }

  private async appendAncestors(
    live: ManagedAgent[],
    selectedLive: ManagedAgent[],
    records: StoredAgentRecord[],
  ): Promise<void> {
    const selectedIds = new Set([...selectedLive, ...records].map((agent) => agent.id));
    const liveById = new Map(live.map((agent) => [agent.id, agent]));
    const pending = [...selectedLive, ...records];
    for (const agent of pending) {
      const parentId = getParentAgentIdFromLabels(agent.labels);
      if (!parentId || selectedIds.has(parentId)) continue;
      selectedIds.add(parentId);
      const liveParent = liveById.get(parentId);
      if (liveParent) {
        pending.push(liveParent);
        selectedLive.push(liveParent);
      } else {
        const storedParent = await this.deps.storage.get(parentId);
        if (storedParent) {
          pending.push(storedParent);
          records.push(storedParent);
        }
      }
    }
  }

  /**
   * Every match, in discovery order, with no UI projection. Archive/background/label/provider
   * predicates are answered from the stored record (live agents keep their record for the
   * archive flag and title, which storage owns).
   */
  async listCandidates(filter?: AgentDirectoryFilter): Promise<AgentDirectoryCandidate[]> {
    const requested = filter?.workspaceIds ? new Set(filter.workspaceIds) : null;
    const live = this.deps.manager.listAgents();
    const liveIds = new Set(live.map((agent) => agent.id));
    const labels = Object.entries(filter?.labels ?? {});
    const visibility = filter?.includeBackground ?? false;
    const records = requested
      ? await this.deps.storage.listByWorkspaces(requested, filter)
      : await this.deps.storage.listActive(filter);
    const selectedLive = requested
      ? live.filter((agent) => requested.has(agent.workspaceId ?? ""))
      : live;
    if (filter?.includeAncestors && requested) {
      await this.appendAncestors(live, selectedLive, records);
    }

    const workspaceIds = new Set(
      [...selectedLive, ...records].flatMap((agent) =>
        agent.workspaceId ? [agent.workspaceId] : [],
      ),
    );
    const backgroundWorkspaceIds = new Set<string>();
    if (visibility !== true) {
      for (const id of workspaceIds) {
        if ((await this.deps.workspaces.get(id))?.background) backgroundWorkspaceIds.add(id);
      }
    }
    const matches = (candidate: AgentDirectoryCandidate) => {
      const record = candidate.record;
      const agent: DiscoverableAgent =
        candidate.kind === "live" ? candidate.agent : candidate.record;
      const workspaceId = agent.workspaceId;
      return (
        (filter?.includeArchived || !record?.archivedAt) &&
        admits(
          agent,
          workspaceId !== undefined && backgroundWorkspaceIds.has(workspaceId),
          visibility,
        ) &&
        labels.every(([key, value]) => agent.labels?.[key] === value) &&
        this.deps.isProviderVisible(providerOf(candidate))
      );
    };

    const liveCandidates = await Promise.all(
      selectedLive.map(async (agent): Promise<AgentDirectoryCandidate> => {
        const record = await this.deps.storage.get(agent.id);
        return { kind: "live", agent, record: record ?? null };
      }),
    );
    const stored: AgentDirectoryCandidate[] = records
      .filter((record) => !liveIds.has(record.id))
      .map((record): AgentDirectoryCandidate => ({ kind: "stored", record }))
      .filter(matches)
      .filter(
        (candidate) =>
          candidate.kind !== "stored" ||
          filter?.includeUnavailablePersisted ||
          this.deps.isStoredProviderAvailable(candidate.record),
      );
    return [...liveCandidates.filter(matches), ...stored];
  }

  /** Project one candidate into the wire payload. */
  project(candidate: AgentDirectoryCandidate): Promise<AgentSnapshotPayload> {
    return candidate.kind === "live"
      ? this.deps.projectLive(candidate.agent)
      : Promise.resolve(this.deps.projectStored(candidate.record));
  }

  async list(filter?: AgentDirectoryFilter): Promise<AgentSnapshotPayload[]> {
    const candidates = await this.listCandidates(filter);
    return Promise.all(candidates.map((candidate) => this.project(candidate)));
  }
}

function providerOf(candidate: AgentDirectoryCandidate): string {
  return candidate.kind === "live" ? candidate.agent.provider : candidate.record.provider;
}

function admits(
  agent: DiscoverableAgent,
  inBackgroundWorkspace: boolean,
  visibility: BackgroundVisibility,
): boolean {
  if (agent.internal) return false;
  if (agent.background) return visibility === true;
  return !inBackgroundWorkspace || visibility !== false;
}

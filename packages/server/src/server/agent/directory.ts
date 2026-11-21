import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
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

/** A running agent in a background workspace, counted against the workspace it rolls up to. */
export interface HiddenRunningRollup {
  workspaceId: string;
  updatedAt: string;
}

export type RollupSource = Pick<StoredAgentRecord, "id" | "workspaceId" | "labels" | "background">;

interface DiscoverableAgent {
  workspaceId?: string;
  internal?: boolean;
  background?: boolean;
}

/** Public agent discovery owns background visibility for live and durable records. */
export class AgentDirectory {
  constructor(
    private readonly deps: {
      manager: Pick<AgentManager, "listAgents" | "getAgentBackgroundWorkSummary">;
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

  /**
   * Running agents in background workspaces, each counted against the workspace it rolls up to.
   * A running agent is always live, so stored records are only read to walk parents. Every agent
   * update rebuilds this, so it reads only what the rule needs and never projects an agent.
   */
  async listHiddenRunningRollups(): Promise<HiddenRunningRollup[]> {
    const live = this.deps.manager.listAgents();
    const liveById = new Map(live.map((agent) => [agent.id, agent]));
    const rollups: HiddenRunningRollup[] = [];
    for (const agent of live) {
      const running = isAgentRunning({
        status: agent.lifecycle,
        backgroundWork: this.deps.manager.getAgentBackgroundWorkSummary(agent.id),
      });
      if (!running || !this.deps.isProviderVisible(agent.provider)) continue;
      if (!(await this.rollsUp(agent))) continue;
      // Archive stores the record before it closes the runtime.
      if ((await this.deps.storage.get(agent.id))?.archivedAt) continue;
      const workspaceId = await this.findVisibleAncestorWorkspaceId(agent, liveById);
      if (workspaceId) rollups.push({ workspaceId, updatedAt: agent.updatedAt.toISOString() });
    }
    return rollups;
  }

  /**
   * The visible workspace that shows a hidden agent's activity: the workspace of its nearest
   * ancestor agent outside a background workspace. Null when the agent has its own visible row,
   * is an agent-level background agent, or its parent chain ends first.
   */
  async resolveRollupWorkspaceId(agent: RollupSource): Promise<string | null> {
    if (!(await this.rollsUp(agent))) return null;
    const live = this.deps.manager.listAgents();
    return this.findVisibleAncestorWorkspaceId(agent, new Map(live.map((a) => [a.id, a])));
  }

  /** Sits in a background workspace and is not itself a background agent. */
  private async rollsUp(agent: RollupSource): Promise<boolean> {
    if (agent.background || !agent.workspaceId) return false;
    return (await this.deps.workspaces.get(agent.workspaceId))?.background === true;
  }

  private async findVisibleAncestorWorkspaceId(
    agent: RollupSource,
    liveById: ReadonlyMap<string, ManagedAgent>,
  ): Promise<string | null> {
    const seen = new Set([agent.id]);
    let parentId = getParentAgentIdFromLabels(agent.labels);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = liveById.get(parentId) ?? (await this.deps.storage.get(parentId));
      if (!parent?.workspaceId) return null;
      const workspace = await this.deps.workspaces.get(parent.workspaceId);
      if (!workspace) return null;
      if (!workspace.background) return workspace.workspaceId;
      parentId = getParentAgentIdFromLabels(parent.labels);
    }
    return null;
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

  async list(filter?: {
    workspaceIds?: Iterable<string>;
    /** Include parent chains by ID for workspace root classification. */
    includeAncestors?: boolean;
    labels?: Record<string, string>;
    includeArchived?: boolean;
    includeBackground?: BackgroundVisibility;
    includeUnavailablePersisted?: boolean;
  }): Promise<AgentSnapshotPayload[]> {
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
    const matches = (
      agent: DiscoverableAgent & { archivedAt?: string | null; labels?: Record<string, string> },
    ) =>
      (filter?.includeArchived || !agent.archivedAt) &&
      admits(
        agent,
        agent.workspaceId !== undefined && backgroundWorkspaceIds.has(agent.workspaceId),
        visibility,
      ) &&
      labels.every(([key, value]) => agent.labels?.[key] === value);
    const stored = records
      .filter((record) => !liveIds.has(record.id) && matches(record))
      .filter(
        (record) =>
          filter?.includeUnavailablePersisted || this.deps.isStoredProviderAvailable(record),
      )
      .map((record) => this.deps.projectStored(record));
    const active = await Promise.all(
      selectedLive.filter(matches).map((agent) => this.deps.projectLive(agent)),
    );
    return [...active, ...stored]
      .filter(matches)
      .filter((agent) => this.deps.isProviderVisible(agent.provider));
  }
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

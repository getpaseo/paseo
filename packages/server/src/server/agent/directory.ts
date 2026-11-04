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
}

/** Public agent discovery owns background visibility for live and durable records. */
export class AgentDirectory {
  constructor(
    private readonly deps: {
      manager: Pick<AgentManager, "listAgents">;
      storage: Pick<
        AgentStorage,
        "listActive" | "listByWorkspaces" | "lastUserMessageAtByWorkspace"
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

  async list(filter?: {
    workspaceIds?: Iterable<string>;
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
    const workspaceIds = new Set(
      [...live, ...records].flatMap((agent) => (agent.workspaceId ? [agent.workspaceId] : [])),
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
      live
        .filter((agent) => !requested || requested.has(agent.workspaceId ?? ""))
        .filter(matches)
        .map((agent) => this.deps.projectLive(agent)),
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

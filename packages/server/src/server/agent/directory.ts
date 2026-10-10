import type { AgentSnapshotPayload } from "../messages.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

/** Public agent discovery owns workspace visibility for live and durable records. */
export class AgentDirectory {
  constructor(
    private readonly deps: {
      manager: AgentManager;
      storage: AgentStorage;
      workspaces: Pick<WorkspaceRegistry, "get" | "list">;
      projectLive(agent: ManagedAgent): Promise<AgentSnapshotPayload>;
      projectStored(record: StoredAgentRecord): AgentSnapshotPayload;
      isProviderVisible(provider: string): boolean;
      isStoredProviderAvailable(record: StoredAgentRecord): boolean;
    },
  ) {}

  async includes(
    agent: Pick<AgentSnapshotPayload, "workspaceId" | "internal">,
    includeBackground = false,
  ): Promise<boolean> {
    if (agent.internal) return false;
    if (includeBackground || !agent.workspaceId) return true;
    return !(await this.deps.workspaces.get(agent.workspaceId))?.background;
  }

  async list(filter?: {
    labels?: Record<string, string>;
    includeArchived?: boolean;
    includeBackground?: boolean;
    includeUnavailablePersisted?: boolean;
  }): Promise<AgentSnapshotPayload[]> {
    const live = this.deps.manager.listAgents();
    const liveIds = new Set(live.map((agent) => agent.id));
    const labels = Object.entries(filter?.labels ?? {});
    const backgroundIds = new Set(
      filter?.includeBackground
        ? []
        : (await this.deps.workspaces.list())
            .filter((workspace) => workspace.background)
            .map((workspace) => workspace.workspaceId),
    );
    const matches = (agent: {
      archivedAt?: string | null;
      workspaceId?: string;
      labels?: Record<string, string>;
    }) =>
      (filter?.includeArchived || !agent.archivedAt) &&
      (filter?.includeBackground || !agent.workspaceId || !backgroundIds.has(agent.workspaceId)) &&
      labels.every(([key, value]) => agent.labels?.[key] === value);
    const stored = (await this.deps.storage.list())
      .filter((record) => !record.internal && !liveIds.has(record.id) && matches(record))
      .filter(
        (record) =>
          filter?.includeUnavailablePersisted || this.deps.isStoredProviderAvailable(record),
      )
      .map((record) => this.deps.projectStored(record));
    const active = await Promise.all(
      live.filter(matches).map((agent) => this.deps.projectLive(agent)),
    );
    return [...active, ...stored].filter((agent) => this.deps.isProviderVisible(agent.provider));
  }
}

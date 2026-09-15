import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

export const ASSISTANT_CATALOG_VERSION = 1;
const MAX_WORKSPACES = 100;
const MAX_AGENTS = 200;
const MAX_LABEL_LENGTH = 120;

export interface AssistantCatalogHost {
  serverId: string;
  label: string;
  status: string;
}

export interface AssistantCatalogWorkspace {
  id: string;
  serverId: string;
  name: string;
  project: string;
  branch: string | null;
  status: string;
  agentCount: number;
  lastActivityAt: string | null;
}

export interface AssistantCatalogAgent {
  id: string;
  serverId: string;
  workspaceId: string | null;
  name: string;
  provider: string;
  status: string;
  lastActivityAt: string;
}

export interface AssistantCatalog {
  version: typeof ASSISTANT_CATALOG_VERSION;
  capturedAt: string;
  hosts: AssistantCatalogHost[];
  workspaces: AssistantCatalogWorkspace[];
  agents: AssistantCatalogAgent[];
  truncated: boolean;
}

export interface AssistantCatalogInput {
  now: Date;
  hosts: readonly AssistantCatalogHost[];
  workspaces: readonly WorkspaceDescriptor[] | ReadonlyMap<string, WorkspaceDescriptor>;
  agents: readonly Agent[] | ReadonlyMap<string, Agent>;
  serverIdOfWorkspace: (workspace: WorkspaceDescriptor) => string;
}

function clip(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, MAX_LABEL_LENGTH);
}

function toArray<T>(value: readonly T[] | ReadonlyMap<string, T>): T[] {
  return Array.isArray(value) ? [...value] : [...(value as ReadonlyMap<string, T>).values()];
}

/**
 * The bounded, name-only view of hosts, workspaces, and agents that the
 * assistant content provider serves. Sorted by recency so truncation drops
 * the stalest entries; paths, prompts, and transcripts never leave the app.
 */
export function buildAssistantCatalog(input: AssistantCatalogInput): AssistantCatalog {
  const agents = toArray(input.agents)
    .filter((agent) => !agent.archivedAt && !agent.parentAgentId)
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  const lastAgentActivityByWorkspace = new Map<string, number>();
  const agentCountByWorkspace = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.workspaceId) continue;
    const key = `${agent.serverId}:${agent.workspaceId}`;
    agentCountByWorkspace.set(key, (agentCountByWorkspace.get(key) ?? 0) + 1);
    const activity = agent.lastActivityAt.getTime();
    if (activity > (lastAgentActivityByWorkspace.get(key) ?? -1)) {
      lastAgentActivityByWorkspace.set(key, activity);
    }
  }

  const workspaces = toArray(input.workspaces)
    .filter((workspace) => !workspace.archivingAt)
    .map((workspace) => {
      const serverId = input.serverIdOfWorkspace(workspace);
      const key = `${serverId}:${workspace.id}`;
      const lastActivity =
        lastAgentActivityByWorkspace.get(key) ?? workspace.statusEnteredAt?.getTime() ?? null;
      return {
        id: workspace.id,
        serverId,
        name: clip(workspace.title) || clip(workspace.name),
        project: clip(workspace.projectCustomName) || clip(workspace.projectDisplayName),
        branch: clip(workspace.gitRuntime?.currentBranch) || null,
        status: workspace.status,
        agentCount: agentCountByWorkspace.get(key) ?? 0,
        lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
      };
    })
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));

  const truncated = workspaces.length > MAX_WORKSPACES || agents.length > MAX_AGENTS;
  return {
    version: ASSISTANT_CATALOG_VERSION,
    capturedAt: input.now.toISOString(),
    hosts: input.hosts.map((host) => ({
      serverId: host.serverId,
      label: clip(host.label) || host.serverId,
      status: host.status,
    })),
    workspaces: workspaces.slice(0, MAX_WORKSPACES),
    agents: agents.slice(0, MAX_AGENTS).map((agent) => ({
      id: agent.id,
      serverId: agent.serverId,
      workspaceId: agent.workspaceId ?? null,
      name: clip(agent.title) || clip(agent.cwd.split("/").pop()) || agent.id,
      provider: agent.provider,
      status: agent.status,
      lastActivityAt: agent.lastActivityAt.toISOString(),
    })),
    truncated,
  };
}

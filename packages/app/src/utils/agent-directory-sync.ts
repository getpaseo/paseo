import type { FetchAgentsEntry } from "@server/client/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  derivePendingPermissionKey,
  normalizeAgentSnapshot,
} from "@/utils/agent-snapshots";
import { resolveProjectPlacement } from "@/utils/project-placement";

type PendingPermissionEntry = {
  key: string;
  agentId: string;
  request: Agent["pendingPermissions"][number];
};

export function buildAgentDirectoryState(input: {
  serverId: string;
  entries: FetchAgentsEntry[];
}): {
  agents: Map<string, Agent>;
  pendingPermissions: Map<string, PendingPermissionEntry>;
} {
  const agents = new Map<string, Agent>();
  const pendingPermissions = new Map<string, PendingPermissionEntry>();

  for (const entry of input.entries) {
    const normalized = normalizeAgentSnapshot(entry.agent, input.serverId);
    const projectPlacement = resolveProjectPlacement({
      projectPlacement: entry.project,
      cwd: normalized.cwd,
    });
    const agent: Agent = {
      ...normalized,
      projectPlacement,
    };
    agents.set(agent.id, agent);

    for (const request of agent.pendingPermissions) {
      const key = derivePendingPermissionKey(agent.id, request);
      pendingPermissions.set(key, { key, agentId: agent.id, request });
    }
  }

  return { agents, pendingPermissions };
}

export function applyFetchedAgentDirectory(input: {
  serverId: string;
  entries: FetchAgentsEntry[];
}): { agents: Map<string, Agent> } {
  const { agents: fetchedAgents, pendingPermissions } = buildAgentDirectoryState(input);

  const store = useSessionStore.getState();

  store.setAgents(input.serverId, (prev) => {
    const merged = new Map(prev);
    for (const [id, agent] of fetchedAgents) {
      merged.set(id, agent);
    }
    return merged;
  });

  const lastActivityByAgentId = new Map<string, Date>();
  for (const agent of fetchedAgents.values()) {
    lastActivityByAgentId.set(agent.id, agent.lastActivityAt);
  }
  store.setAgentLastActivityBatch(lastActivityByAgentId);

  store.setPendingPermissions(input.serverId, (prev) => {
    const merged = new Map(prev);
    for (const [key, entry] of pendingPermissions) {
      merged.set(key, entry);
    }
    return merged;
  });
  store.setInitializingAgents(input.serverId, new Map());
  store.setHasHydratedAgents(input.serverId, true);
  return { agents: fetchedAgents };
}

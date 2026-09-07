import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { Agent } from "@/stores/session-store";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { resolveProjectPlacement } from "@/utils/project-placement";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type AgentDirectoryFetchEntry = FetchAgentsEntry;
export type AgentDirectoryDelta = Extract<
  SessionOutboundMessage,
  { type: "agent_update" }
>["payload"];

// Directory membership can disappear without the underlying agent being deleted.
export type AgentRemovalReason = "scope" | "deleted";

interface PendingPermissionEntry {
  key: string;
  agentId: string;
  request: Agent["pendingPermissions"][number];
}

export function buildAgentDirectoryState(input: {
  serverId: string;
  entries: AgentDirectoryFetchEntry[];
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

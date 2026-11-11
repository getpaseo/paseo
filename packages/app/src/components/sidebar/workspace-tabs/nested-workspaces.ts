import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";

/** The agent fields the rule reads, so it can run on session-store agents and test fixtures. */
export interface NestingAgent {
  id: string;
  workspaceId?: string;
  archivedAt?: Date | null;
  background?: boolean;
  labels: Record<string, string>;
}

export interface SelectNestedSubagentWorkspaceKeysInput {
  agentsByServerId: ReadonlyMap<string, ReadonlyMap<string, NestingAgent>>;
  /**
   * The workspace key where an agent's tab is open, by `${serverId}:${agentId}`. The tab is where
   * the agent's subagents are listed, so it decides where they nest.
   */
  agentTabWorkspaceKeys: ReadonlyMap<string, string>;
}

/**
 * Workspaces that exist for subagents and are listed under their parent instead of on their own
 * sidebar row: `${serverId}:${workspaceId}` keys, sorted.
 *
 * A workspace nests only when every live agent in it is a subagent whose parent has a tab open in
 * another workspace, so each child stays reachable from the parent's tab list. The parent is found
 * through its tab rather than its record: an older parent can be missing from the host's agent
 * list the client holds while its tab is open and lists the children.
 * One agent of its own, or a parent without a tab, keeps the row. Background agents are ignored:
 * they are not listed anywhere, so they neither keep a row nor need one. Nesting is one level
 * deep, so a workspace whose parent's own workspace nests stays on its row.
 */
export function selectNestedSubagentWorkspaceKeys({
  agentsByServerId,
  agentTabWorkspaceKeys,
}: SelectNestedSubagentWorkspaceKeysInput): string[] {
  const parentWorkspaceKeysByCandidate = new Map<string, Set<string> | null>();
  for (const [serverId, agents] of agentsByServerId) {
    for (const agent of agents.values()) {
      if (agent.archivedAt || agent.background || !agent.workspaceId) continue;
      const workspaceKey = `${serverId}:${agent.workspaceId}`;
      const parentWorkspaceKeys = parentWorkspaceKeysByCandidate.get(workspaceKey);
      if (parentWorkspaceKeys === null) continue;
      const parentKey = nestingParentWorkspaceKey(
        agent,
        serverId,
        agentsByServerId,
        agentTabWorkspaceKeys,
      );
      if (!parentKey || parentKey === workspaceKey) {
        parentWorkspaceKeysByCandidate.set(workspaceKey, null);
        continue;
      }
      if (parentWorkspaceKeys) parentWorkspaceKeys.add(parentKey);
      else parentWorkspaceKeysByCandidate.set(workspaceKey, new Set([parentKey]));
    }
  }
  const nested: string[] = [];
  for (const [workspaceKey, parentWorkspaceKeys] of parentWorkspaceKeysByCandidate) {
    if (!parentWorkspaceKeys) continue;
    const parentNests = [...parentWorkspaceKeys].some((key) =>
      Boolean(parentWorkspaceKeysByCandidate.get(key)),
    );
    if (!parentNests) nested.push(workspaceKey);
  }
  return nested.sort();
}

function nestingParentWorkspaceKey(
  agent: NestingAgent,
  serverId: string,
  agentsByServerId: SelectNestedSubagentWorkspaceKeysInput["agentsByServerId"],
  agentTabWorkspaceKeys: SelectNestedSubagentWorkspaceKeysInput["agentTabWorkspaceKeys"],
): string | null {
  const address = getParentAddressFromLabels(agent.labels, serverId);
  if (!address) return null;
  const parent = agentsByServerId.get(address.serverId)?.get(address.agentId);
  if (parent?.archivedAt) return null;
  return agentTabWorkspaceKeys.get(`${address.serverId}:${address.agentId}`) ?? null;
}

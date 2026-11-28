import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentOwner } from "./agent-owner.js";
import type { AgentPermissionResponse } from "./agent-sdk-types.js";

export interface UnattendedPermissionPolicyAgent {
  id: string;
  owner?: AgentOwner;
  labels?: Record<string, string>;
}

export type LookupParentAgent = (
  agentId: string,
) =>
  | UnattendedPermissionPolicyAgent
  | null
  | undefined
  | Promise<UnattendedPermissionPolicyAgent | null | undefined>;

export const UNATTENDED_HUB_PERMISSION_DENY_MESSAGE =
  "This is an unattended automated run with no person present to approve tool permissions or interactive prompts. Rewrite or replace the command so it runs without requiring approval (for example, avoid wildcard deletes like `rm -rf ./*` or interactive prompts) and continue.";

export function buildUnattendedHubPermissionDenyResponse(): AgentPermissionResponse {
  return {
    behavior: "deny",
    message: UNATTENDED_HUB_PERMISSION_DENY_MESSAGE,
  };
}

/**
 * Returns true when an agent is a Hub-dispatched execution or any delegated
 * descendant of one, so unexpected permission prompts cannot wait for a human.
 */
export async function isUnattendedHubExecutionAgent(
  agent: UnattendedPermissionPolicyAgent,
  lookupAgent: LookupParentAgent,
): Promise<boolean> {
  const visited = new Set<string>([agent.id]);
  let current: UnattendedPermissionPolicyAgent | null | undefined = agent;
  while (current) {
    if (current.owner?.kind === "daemon") {
      return true;
    }
    const parentId = getParentAgentIdFromLabels(current.labels);
    if (!parentId || visited.has(parentId)) {
      return false;
    }
    visited.add(parentId);
    current = await lookupAgent(parentId);
  }
  return false;
}

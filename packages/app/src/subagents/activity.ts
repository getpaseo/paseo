import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent, SessionState } from "@/stores/session-store";

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function managedActivityKey(address: AgentAddress): string {
  return `${address.serverId}\0${address.agentId}`;
}

/** Each ancestor is visited once, including malformed cycles. */
function activeAncestors(
  parents: ReadonlyMap<string, string | null>,
  active: readonly string[],
): Set<string> {
  const ancestors = new Set<string>();
  for (const id of active) {
    let parent = parents.get(id);
    while (parent && parents.has(parent) && !ancestors.has(parent)) {
      ancestors.add(parent);
      parent = parents.get(parent);
    }
  }
  return ancestors;
}

export function providerRunningDescendants(
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
): Set<string> {
  const parents = new Map<string, string | null>();
  const running: string[] = [];
  for (const [key, descriptor] of descriptors) {
    const prefix = key.slice(0, key.lastIndexOf("\0") + 1);
    parents.set(
      key,
      descriptor.parentSubagentId ? `${prefix}${descriptor.parentSubagentId}` : null,
    );
    if (descriptor.status === "running") running.push(key);
  }
  return activeAncestors(parents, running);
}

interface SubagentActivityStatusInput {
  status: Agent["status"];
  isSelfActive: boolean;
  hasActiveDescendants: boolean;
}

export function subagentActivityStatus({
  status,
  isSelfActive,
  hasActiveDescendants,
}: SubagentActivityStatusInput): Agent["status"] {
  if (isSelfActive) return "running";
  if (status === "error") return "error";
  return hasActiveDescendants ? "running" : status;
}

interface SubagentActivitySession extends Pick<SessionState, "agents" | "serverInfo"> {
  client: Pick<NonNullable<SessionState["client"]>, "listProviderSubagents"> | null;
}
export type SubagentActivitySessions = Readonly<Record<string, SubagentActivitySession>>;

export interface SubagentActivityInput {
  sessions: SubagentActivitySessions;
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>;
  hiddenFromTrack: ReadonlySet<string>;
  pendingArchiveKeys: ReadonlySet<string>;
}

export interface SubagentActivity {
  managed: ReadonlySet<string>;
  provider: ReadonlySet<string>;
  children: ReadonlyMap<string, readonly AgentAddress[]>;
}

export function sameActivitySessions(
  left: SubagentActivitySessions,
  right: SubagentActivitySessions,
): boolean {
  if (left === right) return true;
  const serverIds = Object.keys(left);
  return (
    serverIds.length === Object.keys(right).length &&
    serverIds.every((serverId) => {
      const previous = left[serverId];
      const current = right[serverId];
      return (
        previous?.agents === current?.agents &&
        previous?.client === current?.client &&
        previous?.serverInfo?.features?.providerSubagents ===
          current?.serverInfo?.features?.providerSubagents &&
        previous?.serverInfo?.features?.providerSubagentNesting ===
          current?.serverInfo?.features?.providerSubagentNesting
      );
    })
  );
}

function samePendingArchiveKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

// All hosts share one graph: a remote descendant can contribute to an ancestor on another host.
// Timeline-only updates compare source map references without walking agents or descriptors.
let cachedActivity: { input: SubagentActivityInput; activity: SubagentActivity } | undefined;

export function getSubagentActivity(input: SubagentActivityInput): SubagentActivity {
  const previous = cachedActivity;
  if (
    previous &&
    sameActivitySessions(previous.input.sessions, input.sessions) &&
    previous.input.descriptors === input.descriptors &&
    previous.input.hiddenFromTrack === input.hiddenFromTrack &&
    samePendingArchiveKeys(previous.input.pendingArchiveKeys, input.pendingArchiveKeys)
  )
    return previous.activity;
  const activity = deriveSubagentActivity(input);
  cachedActivity = { input, activity };
  return activity;
}

interface ActivityGraph {
  parents: Map<string, string | null>;
  children: Map<string, AgentAddress[]>;
  active: string[];
}

function managedActivityGraph(input: SubagentActivityInput): ActivityGraph {
  const parents = new Map<string, string | null>();
  const children = new Map<string, AgentAddress[]>();
  const active: string[] = [];
  for (const [serverId, session] of Object.entries(input.sessions)) {
    for (const agent of session.agents.values()) {
      if (agent.archivedAt || input.pendingArchiveKeys.has(`${serverId}:${agent.id}`)) continue;
      const address = { serverId, agentId: agent.id };
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      const key = `managed\0${managedActivityKey(address)}`;
      parents.set(key, parent ? `managed\0${managedActivityKey(parent)}` : null);
      if (agent.turn.phase === "open" || agent.status === "initializing") active.push(key);
      if (parent) {
        const parentKey = managedActivityKey(parent);
        const siblings = children.get(parentKey) ?? [];
        siblings.push(address);
        children.set(parentKey, siblings);
      }
    }
  }
  return { parents, children, active };
}

function deriveSubagentActivity(input: SubagentActivityInput): SubagentActivity {
  const { parents, children, active } = managedActivityGraph(input);
  for (const [key, descriptor] of input.descriptors) {
    const serverId = key.slice(0, key.indexOf("\0"));
    const features = input.sessions[serverId]?.serverInfo?.features;
    if (!features?.providerSubagents || input.hiddenFromTrack.has(key)) continue;
    const address = { serverId, agentId: descriptor.parentAgentId };
    const parent =
      features.providerSubagentNesting && descriptor.parentSubagentId
        ? `provider\0${providerSubagentKey(serverId, descriptor.parentAgentId, descriptor.parentSubagentId)}`
        : `managed\0${managedActivityKey(address)}`;
    const nodeKey = `provider\0${key}`;
    parents.set(nodeKey, parent);
    if (descriptor.status === "running") active.push(nodeKey);
  }
  const ancestors = activeAncestors(parents, active);
  const managed = new Set<string>();
  const provider = new Set<string>();
  for (const key of ancestors) {
    if (key.startsWith("managed\0")) managed.add(key.slice("managed\0".length));
    else provider.add(key.slice("provider\0".length));
  }
  return { managed, provider, children };
}

export function managedSubtreeAddresses(
  activity: SubagentActivity,
  parent: AgentAddress,
): AgentAddress[] {
  const addresses = new Map([[managedActivityKey(parent), parent]]);
  for (const [key] of addresses) {
    for (const child of activity.children.get(key) ?? [])
      addresses.set(managedActivityKey(child), child);
  }
  return [...addresses.values()];
}

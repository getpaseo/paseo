import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
} from "@getpaseo/protocol/agent-state-bucket";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { STATUS_BUCKET_ORDER, type SidebarStateBucket } from "@/utils/sidebar-agent-state";

/** A subagent state the sidebar disclosure marks. Working and idle do not. */
export type SubagentDisclosureNotice = "needs_input" | "failed" | "attention";

export interface DisclosureNoticeAgent {
  id: string;
  serverId: string;
  workspaceId?: string;
  archivedAt?: Date | null;
  background?: boolean;
  labels: Record<string, string>;
  status: AgentLifecycleStatus;
  /** An open turn counts as running, the same way the sidebar's workspace status does. */
  turnOpen: boolean;
  pendingPermissionCount: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
}

/**
 * Needs input, an unread failure, or unread finished work. A workspace status is included only
 * when the caller passes one: that is the nested workspace's own status, which its hidden row
 * can no longer show. Mark unread lives on that status after the agent's attention is cleared.
 */
export function noticeForPaseoAgent(
  agent: DisclosureNoticeAgent,
  workspaceStatus: SidebarStateBucket | null,
): SubagentDisclosureNotice | null {
  const status = agentNoticeStatus(agent);
  const agentNotice = asDisclosureNotice(
    deriveAgentStateBucket({
      status,
      pendingPermissionCount: agent.pendingPermissionCount,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    }),
  );
  return moreUrgentDisclosureNotice(agentNotice, asDisclosureNotice(workspaceStatus));
}

export function noticeForProviderSubagent(
  status: ProviderSubagentDescriptorPayload["status"],
): SubagentDisclosureNotice | null {
  return status === "failed" ? "failed" : null;
}

export function moreUrgentDisclosureNotice(
  left: SubagentDisclosureNotice | null,
  right: SubagentDisclosureNotice | null,
): SubagentDisclosureNotice | null {
  if (!left) return right;
  if (!right) return left;
  return STATUS_BUCKET_ORDER.indexOf(left) <= STATUS_BUCKET_ORDER.indexOf(right) ? left : right;
}

export function paseoDisclosureNotice(input: {
  listingServerId: string;
  listingWorkspaceId: string;
  parentAgentIds: ReadonlySet<string>;
  agents: Iterable<DisclosureNoticeAgent>;
  pendingArchiveIds: ReadonlySet<string>;
  workspaceStatus: (serverId: string, workspaceId: string) => SidebarStateBucket | null;
}): SubagentDisclosureNotice | null {
  if (input.parentAgentIds.size === 0) return null;
  const byServer = new Map<string, DisclosureNoticeAgent[]>();
  for (const agent of input.agents) {
    const serverAgents = byServer.get(agent.serverId);
    if (serverAgents) serverAgents.push(agent);
    else byServer.set(agent.serverId, [agent]);
  }
  return noticeForIndexedChildren({
    listingServerId: input.listingServerId,
    listingWorkspaceId: input.listingWorkspaceId,
    parentAgentIds: input.parentAgentIds,
    childrenByParent: indexDisclosureChildren(byServer),
    pendingArchiveIds: input.pendingArchiveIds,
    workspaceStatus: input.workspaceStatus,
  });
}

export interface IndexedDisclosureChild {
  id: string;
  serverId: string;
  workspaceId: string | undefined;
  /** Agent-level notice. The listing workspace's own status is applied later. */
  notice: SubagentDisclosureNotice | null;
}

/**
 * Children grouped by `${parentServerId}:${parentAgentId}`. Archived and background agents are
 * left out. Pending archive is not: that set changes on its own, so the caller filters it.
 */
export function indexDisclosureChildren(
  agentsByServerId: Iterable<[string, Iterable<DisclosureNoticeAgent>]>,
): ReadonlyMap<string, readonly IndexedDisclosureChild[]> {
  const byParent = new Map<string, IndexedDisclosureChild[]>();
  for (const [serverId, agents] of agentsByServerId) {
    for (const agent of agents) {
      if (agent.archivedAt || agent.background) continue;
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      if (!parent) continue;
      const child: IndexedDisclosureChild = {
        id: agent.id,
        serverId: agent.serverId,
        workspaceId: agent.workspaceId,
        notice: noticeForPaseoAgent(agent, null),
      };
      const key = `${parent.serverId}:${parent.agentId}`;
      const list = byParent.get(key);
      if (list) list.push(child);
      else byParent.set(key, [child]);
    }
  }
  return byParent;
}

export interface DisclosureNoticeListing {
  listingServerId: string;
  listingWorkspaceId: string;
  workspaceStatus: (serverId: string, workspaceId: string) => SidebarStateBucket | null;
}

/**
 * One subagent's notice: its agent's own, or its workspace's when it runs in a workspace of its
 * own, which nests under the listing one and so cannot show its status on its own row.
 */
export function noticeForIndexedChild(
  child: IndexedDisclosureChild,
  listing: DisclosureNoticeListing,
): SubagentDisclosureNotice | null {
  const workspaceId = child.workspaceId;
  const ownWorkspace =
    workspaceId !== undefined &&
    (child.serverId !== listing.listingServerId || workspaceId !== listing.listingWorkspaceId);
  const workspaceNotice = ownWorkspace
    ? asDisclosureNotice(listing.workspaceStatus(child.serverId, workspaceId))
    : null;
  return moreUrgentDisclosureNotice(child.notice, workspaceNotice);
}

/**
 * What a subagent row marks beside its title: the states its status icon cannot show. Failed is
 * left to the icon, which already draws it.
 */
export function subagentRowNotice(
  notice: SubagentDisclosureNotice | null,
): Exclude<SubagentDisclosureNotice, "failed"> | null {
  return notice === "failed" ? null : notice;
}

export function noticeForIndexedChildren(input: {
  listingServerId: string;
  listingWorkspaceId: string;
  parentAgentIds: Iterable<string>;
  childrenByParent: ReadonlyMap<string, readonly IndexedDisclosureChild[]>;
  pendingArchiveIds: ReadonlySet<string>;
  workspaceStatus: (serverId: string, workspaceId: string) => SidebarStateBucket | null;
}): SubagentDisclosureNotice | null {
  let notice: SubagentDisclosureNotice | null = null;
  for (const parentAgentId of input.parentAgentIds) {
    const children = input.childrenByParent.get(`${input.listingServerId}:${parentAgentId}`);
    if (!children) continue;
    for (const child of children) {
      if (input.pendingArchiveIds.has(`${child.serverId}:${child.id}`)) continue;
      notice = moreUrgentDisclosureNotice(notice, noticeForIndexedChild(child, input));
    }
  }
  return notice;
}

export function providerDisclosureNotice(input: {
  serverId: string;
  parentAgentIds: ReadonlySet<string>;
  descriptors: Iterable<[string, ProviderSubagentDescriptorPayload]>;
  hiddenFromTrack: ReadonlySet<string>;
  nestingSupported: boolean;
}): SubagentDisclosureNotice | null {
  if (input.parentAgentIds.size === 0) return null;
  const prefix = `${input.serverId}\0`;
  let notice: SubagentDisclosureNotice | null = null;
  for (const [key, subagent] of input.descriptors) {
    if (!key.startsWith(prefix) || input.hiddenFromTrack.has(key)) continue;
    if (!input.parentAgentIds.has(subagent.parentAgentId)) continue;
    if (input.nestingSupported && subagent.parentSubagentId) continue;
    notice = moreUrgentDisclosureNotice(notice, noticeForProviderSubagent(subagent.status));
  }
  return notice;
}

function agentNoticeStatus(
  agent: DisclosureNoticeAgent,
): DisclosureNoticeAgent["status"] | "running" {
  if (agent.turnOpen) return "running";
  if (agent.status === "running") return "idle";
  return agent.status;
}

function asDisclosureNotice(
  bucket: SidebarStateBucket | null | undefined,
): SubagentDisclosureNotice | null {
  if (bucket === "needs_input" || bucket === "failed" || bucket === "attention") return bucket;
  return null;
}

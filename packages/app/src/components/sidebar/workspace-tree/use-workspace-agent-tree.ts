import { useMemo } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  useProviderSubagentStore,
  providerSubagentLifecycleStatus,
} from "@/subagents/provider-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { buildWorkspaceAgentTree, type AgentTreeNode, type WorkspaceAgentNode } from "./agent-tree";

const EMPTY_NODES: WorkspaceAgentNode[] = [];

function toAgentNode(agent: Agent): WorkspaceAgentNode {
  return {
    id: agent.id,
    kind: "paseo",
    parentAgentId: agent.parentAgentId,
    workspaceId: normalizeWorkspaceOpaqueId(agent.workspaceId) ?? "",
    title: agent.title,
    status: agent.status,
    provider: agent.provider,
    requiresAttention: Boolean(agent.requiresAttention),
    attentionReason: agent.attentionReason ?? null,
    pendingPermissionCount: agent.pendingPermissions.length,
    createdAt: agent.createdAt.getTime(),
  };
}

/**
 * Project provider subagents (OMP task tool, Claude child sessions, etc.) as
 * leaf nodes parented to their Paseo agent. Provider subagents live in a
 * separate store keyed by `${serverId}\0${parentAgentId}\0${subagentId}`.
 */
function selectProviderSubagentNodes(
  descriptors: Map<string, ProviderSubagentDescriptorPayload>,
  hiddenFromTrack: Set<string>,
  serverId: string,
  paseoAgentIds: Set<string>,
): WorkspaceAgentNode[] {
  if (descriptors.size === 0) {
    return EMPTY_NODES;
  }
  const prefix = `${serverId}\0`;
  const nodes: WorkspaceAgentNode[] = [];
  for (const [key, descriptor] of descriptors) {
    if (!key.startsWith(prefix) || hiddenFromTrack.has(key)) {
      continue;
    }
    // Only include provider subagents whose parent is a Paseo agent in this workspace.
    if (!paseoAgentIds.has(descriptor.parentAgentId)) {
      continue;
    }
    nodes.push({
      id: descriptor.id,
      kind: "provider",
      parentAgentId: descriptor.parentAgentId,
      workspaceId: "",
      title: descriptor.title ?? descriptor.description,
      status: providerSubagentLifecycleStatus(descriptor.status),
      provider: descriptor.provider,
      requiresAttention: descriptor.status === "failed",
      attentionReason: descriptor.status === "failed" ? "error" : null,
      pendingPermissionCount: 0,
      createdAt: new Date(descriptor.createdAt).getTime(),
    });
  }
  return nodes;
}

/**
 * Project a workspace's live, unarchived Paseo agents into a flat, comparable
 * list.
 *
 * Root membership is by workspaceId. Subagents are pulled in by parentage:
 * any agent whose parent is already in the set is included regardless of its
 * own workspaceId, so subagents with an unset or cross-workspace workspaceId
 * still nest under their parent. This mirrors how the subagents track
 * (`selectSubagentsForParent`) resolves children — by `parentAgentId`, not
 * workspace.
 */
export function selectPaseoAgentNodes(
  sessions: Record<string, SessionState | undefined>,
  serverId: string,
  workspaceId: string,
): WorkspaceAgentNode[] {
  const agents = sessions[serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_NODES;
  }
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  if (!normalizedWorkspaceId) {
    return EMPTY_NODES;
  }

  // First pass: agents whose workspaceId matches (roots + same-workspace children).
  const nodeById = new Map<string, WorkspaceAgentNode>();
  for (const agent of agents.values()) {
    if (agent.archivedAt) {
      continue;
    }
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizedWorkspaceId) {
      const node = toAgentNode(agent);
      nodeById.set(node.id, node);
    }
  }

  // Second pass: pull in subagents by parentage, regardless of workspaceId.
  // Repeat until no new agents are added (handles arbitrary nesting depth).
  let added = true;
  while (added) {
    added = false;
    for (const agent of agents.values()) {
      if (agent.archivedAt || nodeById.has(agent.id)) {
        continue;
      }
      if (agent.parentAgentId && nodeById.has(agent.parentAgentId)) {
        nodeById.set(agent.id, toAgentNode(agent));
        added = true;
      }
    }
  }

  return Array.from(nodeById.values());
}

/**
 * Project provider subagents for a workspace, filtered to those whose parent
 * is in the given Paseo agent set. Reads only the provider subagent store.
 */
export function selectProviderSubagentNodesForWorkspace(
  descriptors: Map<string, ProviderSubagentDescriptorPayload>,
  hiddenFromTrack: Set<string>,
  serverId: string,
  paseoAgentIds: Set<string>,
): WorkspaceAgentNode[] {
  return selectProviderSubagentNodes(descriptors, hiddenFromTrack, serverId, paseoAgentIds);
}

/**
 * Read the nested agent tree for a workspace. Rebuilds when either the session
 * store (Paseo agents) or the provider subagent store (OMP task children, etc.)
 * changes — so provider subagents appear on-the-fly as they are created.
 */
export function useWorkspaceAgentTree(input: {
  serverId: string;
  workspaceId: string;
}): AgentTreeNode[] {
  const paseoNodes = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectPaseoAgentNodes(state.sessions, input.serverId, input.workspaceId),
    equal,
  );
  const providerSupported = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const providerNodes = useStoreWithEqualityFn(
    useProviderSubagentStore,
    (state) => {
      if (!providerSupported) return EMPTY_NODES;
      const paseoIds = new Set(paseoNodes.map((n) => n.id));
      return selectProviderSubagentNodesForWorkspace(
        state.descriptors,
        state.hiddenFromTrack,
        input.serverId,
        paseoIds,
      );
    },
    equal,
  );
  return useMemo(() => {
    const merged =
      paseoNodes.length > 0 || providerNodes.length > 0
        ? [...paseoNodes, ...providerNodes]
        : EMPTY_NODES;
    return buildWorkspaceAgentTree(merged);
  }, [paseoNodes, providerNodes]);
}

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

/**
 * Epoch milliseconds, or 0 when the source timestamp is missing or unparseable.
 * A NaN here would silently randomize sibling ordering in the tree sort.
 */
function toEpochMs(value: Date | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

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
    createdAt: toEpochMs(agent.createdAt),
  };
}

/**
 * Project provider subagents (OMP task tool, Claude child sessions, etc.) as
 * leaf nodes parented to their Paseo agent. Provider subagents live in a
 * separate store keyed by `${serverId}\0${parentAgentId}\0${subagentId}`.
 *
 * Filtered to descriptors whose parent is in `paseoAgentIds`, so the caller
 * decides workspace membership. Reads only the provider subagent store.
 */
export function selectProviderSubagentNodesForWorkspace(
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
      createdAt: toEpochMs(descriptor.createdAt),
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

  // Single pass over the store: seed the workspace's own agents and index every
  // other live agent by parent, so descendants can be collected by walking the
  // index instead of rescanning the full agent map once per nesting level.
  const nodeById = new Map<string, WorkspaceAgentNode>();
  const childrenByParentId = new Map<string, Agent[]>();
  for (const agent of agents.values()) {
    if (agent.archivedAt) {
      continue;
    }
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizedWorkspaceId) {
      const node = toAgentNode(agent);
      nodeById.set(node.id, node);
      continue;
    }
    if (agent.parentAgentId) {
      const siblings = childrenByParentId.get(agent.parentAgentId);
      if (siblings) {
        siblings.push(agent);
      } else {
        childrenByParentId.set(agent.parentAgentId, [agent]);
      }
    }
  }

  // Pull in subagents by parentage regardless of workspaceId, breadth-first, so
  // agents with an unset or cross-workspace workspaceId still nest under their
  // parent at arbitrary depth.
  const frontier = Array.from(nodeById.keys());
  while (frontier.length > 0) {
    const parentId = frontier.pop();
    if (!parentId) {
      continue;
    }
    const children = childrenByParentId.get(parentId);
    if (!children) {
      continue;
    }
    for (const child of children) {
      if (nodeById.has(child.id)) {
        continue;
      }
      nodeById.set(child.id, toAgentNode(child));
      frontier.push(child.id);
    }
  }

  return Array.from(nodeById.values());
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

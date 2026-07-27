import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

/**
 * Minimal, comparable projection of an agent record. The sidebar tree only
 * needs identity, parentage, and presentation fields — keeping the projection
 * small lets the selector use deep-equal without re-rendering on every
 * unrelated agent store update.
 */
export interface WorkspaceAgentNode {
  id: string;
  /** "paseo" for managed agents, "provider" for provider-owned child sessions (OMP task tool, etc.). */
  kind: "paseo" | "provider";
  parentAgentId: string | null;
  workspaceId: string;
  title: string | null;
  status: AgentLifecycleStatus;
  provider: AgentProvider;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  pendingPermissionCount: number;
  /** Epoch milliseconds — drives stable oldest-first ordering. */
  createdAt: number;
}

export interface AgentTreeNode {
  agent: WorkspaceAgentNode;
  children: AgentTreeNode[];
}

const EMPTY_TREE: AgentTreeNode[] = [];

/**
 * Build a nested agent tree for a single workspace from a flat list of agent
 * projections.
 *
 * Root membership mirrors `isWorkspaceRootAgent`: an agent is a root in this
 * workspace when it has no parent, or its parent lives in a different workspace
 * (a cross-workspace subagent behaves as a root for workspace visibility).
 * Because the input is already filtered to one workspace, "parent is in this
 * workspace" is equivalent to "parent is present in the input set".
 *
 * Nesting is unbounded — subagents of subagents resolve to arbitrary depth.
 */
export function buildWorkspaceAgentTree(nodes: readonly WorkspaceAgentNode[]): AgentTreeNode[] {
  if (nodes.length === 0) {
    return EMPTY_TREE;
  }

  const treeNodes = new Map<string, AgentTreeNode>();
  for (const node of nodes) {
    treeNodes.set(node.id, { agent: node, children: [] });
  }

  const roots: AgentTreeNode[] = [];
  for (const node of nodes) {
    const treeNode = treeNodes.get(node.id);
    if (!treeNode) {
      continue;
    }
    const parentInWorkspace = node.parentAgentId ? treeNodes.has(node.parentAgentId) : false;
    if (node.parentAgentId && parentInWorkspace) {
      const parent = treeNodes.get(node.parentAgentId);
      if (parent) {
        parent.children.push(treeNode);
        continue;
      }
    }
    roots.push(treeNode);
  }

  sortTreeNodes(roots);
  return roots;
}

function sortTreeNodes(nodes: AgentTreeNode[]): void {
  nodes.sort((left, right) => left.agent.createdAt - right.agent.createdAt);
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTreeNodes(node.children);
    }
  }
}

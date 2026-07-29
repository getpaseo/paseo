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
 *
 * Parentage that forms a cycle (only reachable through corrupt data) would
 * otherwise leave every node in the cycle unreachable from any root, silently
 * dropping it from the sidebar. Cycle members are promoted to roots instead, so
 * the agents stay visible and the recursive sort still terminates.
 */
/**
 * Ids of every Paseo-managed agent in the tree, at any depth.
 *
 * Only Paseo agents can own provider subagents, and a nested Paseo subagent can
 * own them too — so this is the full set of parents worth hydrating, not just
 * the roots. Provider nodes are themselves leaves and are skipped.
 */
export function collectPaseoAgentIds(nodes: readonly AgentTreeNode[]): string[] {
  const ids: string[] = [];
  const visit = (current: readonly AgentTreeNode[]): void => {
    for (const node of current) {
      if (node.agent.kind === "paseo") {
        ids.push(node.agent.id);
      }
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return ids;
}

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
    const parent = node.parentAgentId ? treeNodes.get(node.parentAgentId) : undefined;
    if (parent && parent !== treeNode && !isAncestorOf(treeNode, parent, treeNodes)) {
      parent.children.push(treeNode);
      continue;
    }
    roots.push(treeNode);
  }

  sortTreeNodes(roots);
  return roots;
}

/**
 * True when `candidate` is `node` itself or reachable from it by walking
 * parents — i.e. attaching `node` under `candidate` would close a cycle.
 */
function isAncestorOf(
  node: AgentTreeNode,
  candidate: AgentTreeNode,
  treeNodes: Map<string, AgentTreeNode>,
): boolean {
  let current: AgentTreeNode | undefined = candidate;
  const seen = new Set<AgentTreeNode>();
  while (current) {
    if (current === node) {
      return true;
    }
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    const parentId: string | null = current.agent.parentAgentId;
    current = parentId ? treeNodes.get(parentId) : undefined;
  }
  return false;
}

function sortTreeNodes(nodes: AgentTreeNode[]): void {
  nodes.sort((left, right) => left.agent.createdAt - right.agent.createdAt);
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTreeNodes(node.children);
    }
  }
}

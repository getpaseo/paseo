import type { Agent, PermissionRequest, Workspace } from "./types";

const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

function parentId(agent: Agent): string | null {
  return agent.labels[PARENT_AGENT_ID_LABEL] ?? null;
}

/** The most recent activity the snapshot exposes. */
function activityAt(agent: Agent): string {
  return agent.lastUserMessageAt && agent.lastUserMessageAt > agent.updatedAt
    ? agent.lastUserMessageAt
    : agent.updatedAt;
}

export type Lane = "needsYou" | "working" | "done";
export type CardReason = "question" | "permission" | "error" | "working" | "finished";

export interface InboxCard {
  agent: Agent;
  workspace: Workspace | null;
  lane: Lane;
  reason: CardReason;
  /** The request to answer. May belong to a same-workspace subagent. */
  request: PermissionRequest | null;
  requestAgentId: string;
  subagentCount: number;
  /** When the agent entered its current state. */
  since: string | null;
}

export type Lanes = Record<Lane, InboxCard[]>;

export interface ProjectLanesOptions {
  workspaceId?: string;
}

/**
 * A subagent rolls up into its parent when both live in the same workspace,
 * which mirrors how the sidebar aggregates workspace status. A cross-workspace
 * subagent is its own card.
 */
function groupByRoot(agents: readonly Agent[]): Map<string, Agent[]> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, Agent[]>();
  for (const agent of agents) {
    let root = agent;
    const seen = new Set<string>();
    let parentAgentId = parentId(root);
    while (parentAgentId && !seen.has(root.id)) {
      seen.add(root.id);
      const parent = byId.get(parentAgentId);
      if (!parent || parent.workspaceId !== root.workspaceId) break;
      root = parent;
      parentAgentId = parentId(root);
    }
    const group = groups.get(root.id) ?? [];
    if (root.id === agent.id) group.unshift(agent);
    else group.push(agent);
    groups.set(root.id, group);
  }
  return groups;
}

function firstRequest(
  agents: readonly Agent[],
): { request: PermissionRequest; agentId: string } | null {
  for (const agent of agents) {
    const request = agent.pendingPermissions[0];
    if (request) return { request, agentId: agent.id };
  }
  return null;
}

function toCard(
  root: Agent,
  members: readonly Agent[],
  workspace: Workspace | null,
): InboxCard | null {
  const base = {
    agent: root,
    workspace,
    subagentCount: members.length - 1,
  };
  const pending = firstRequest(members);
  if (pending) {
    return {
      ...base,
      lane: "needsYou",
      reason: pending.request.kind === "question" ? "question" : "permission",
      request: pending.request,
      requestAgentId: pending.agentId,
      since: root.attentionTimestamp ?? activityAt(root),
    };
  }
  const errored = members.find(
    (agent) =>
      agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error"),
  );
  if (errored) {
    return {
      ...base,
      lane: "needsYou",
      reason: "error",
      request: null,
      requestAgentId: errored.id,
      since: errored.attentionTimestamp ?? activityAt(errored),
    };
  }
  const running = members.some(
    (agent) => agent.status === "running" || agent.status === "initializing",
  );
  if (running) {
    return {
      ...base,
      lane: "working",
      reason: "working",
      request: null,
      requestAgentId: root.id,
      since: root.activeTurn?.startedAt ?? activityAt(root),
    };
  }
  if (root.requiresAttention && root.attentionReason === "finished") {
    return {
      ...base,
      lane: "done",
      reason: "finished",
      request: null,
      requestAgentId: root.id,
      since: root.attentionTimestamp ?? activityAt(root),
    };
  }
  return null;
}

function time(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const NEEDS_YOU_RANK: Record<CardReason, number> = {
  question: 0,
  permission: 0,
  error: 1,
  working: 2,
  finished: 3,
};

export function projectLanes(
  agents: Iterable<Agent>,
  workspaces: ReadonlyMap<string, Workspace>,
  options: ProjectLanesOptions = {},
): Lanes {
  const active = Array.from(agents).filter(
    (agent) =>
      !agent.archivedAt && (!options.workspaceId || agent.workspaceId === options.workspaceId),
  );
  const lanes: Lanes = { needsYou: [], working: [], done: [] };
  for (const [rootId, members] of groupByRoot(active)) {
    const root = members.find((agent) => agent.id === rootId);
    if (!root) continue;
    const workspace = root.workspaceId ? (workspaces.get(root.workspaceId) ?? null) : null;
    const card = toCard(root, members, workspace);
    if (card) lanes[card.lane].push(card);
  }
  lanes.needsYou.sort(
    (a, b) => time(a.since) - time(b.since) || NEEDS_YOU_RANK[a.reason] - NEEDS_YOU_RANK[b.reason],
  );
  lanes.working.sort((a, b) => time(activityAt(b.agent)) - time(activityAt(a.agent)));
  lanes.done.sort((a, b) => time(b.since) - time(a.since));
  return lanes;
}

export function formatSince(iso: string | null, now: number = Date.now()): string {
  const start = time(iso);
  if (!start) return "";
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

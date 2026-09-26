import type { Agent } from "@/stores/session-store";

/**
 * Whether an agent's managed descendants are still producing work.
 *
 * `blocked` means a descendant is waiting on the user (a permission request), which is stronger
 * than `active` and must surface as `needs_input` rather than a neutral "waiting" state.
 */
export type SubagentActivity = "none" | "active" | "blocked";

/** Combined derivation for a whole directory snapshot, keyed by agent ID. */
export interface SubagentActivityIndex {
  childrenByParentId: ReadonlyMap<string, Agent[]>;
  /** Descendant-only activity. A node's own state is excluded — see `ownActivity`. */
  descendantsByAgentId: ReadonlyMap<string, SubagentActivity>;
}

/** Combines signals from more than one source (managed agents, provider-native subagents). */
export function mergeSubagentActivity(
  ...activities: readonly SubagentActivity[]
): SubagentActivity {
  if (activities.includes("blocked")) {
    return "blocked";
  }
  if (activities.includes("active")) {
    return "active";
  }
  return "none";
}

// The store swaps `session.agents` for a new Map on every agent change and keeps the same Map
// through unrelated writes (tokens, timelines). Keying here makes repeated selector runs over an
// unchanged directory O(1) instead of re-walking every agent, which is what open agent panels do.
const activityIndexCache = new WeakMap<ReadonlyMap<string, Agent>, SubagentActivityIndex>();

/**
 * Descendant activity for every agent in one directory reference, built once and reused for the
 * lifetime of that reference.
 */
export function getSubagentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
): SubagentActivityIndex {
  const cached = activityIndexCache.get(agents);
  if (cached) {
    return cached;
  }
  const index = buildSubagentActivityIndex(agents);
  activityIndexCache.set(agents, index);
  return index;
}

/**
 * Descendant activity for one agent. Panels call this per store notification; the shared index
 * keeps a whole directory walk from happening behind each of them.
 */
export function selectSubagentActivity(
  agents: ReadonlyMap<string, Agent> | null | undefined,
  agentId: string,
): SubagentActivity {
  if (!agents || agents.size === 0) {
    return "none";
  }
  return getSubagentActivityIndex(agents).descendantsByAgentId.get(agentId) ?? "none";
}

function buildSubagentActivityIndex(agents: ReadonlyMap<string, Agent>): SubagentActivityIndex {
  const childrenByParentId = new Map<string, Agent[]>();
  for (const agent of agents.values()) {
    const parentAgentId = agent.parentAgentId;
    if (!parentAgentId) {
      continue;
    }
    const siblings = childrenByParentId.get(parentAgentId);
    if (siblings) {
      siblings.push(agent);
    } else {
      childrenByParentId.set(parentAgentId, [agent]);
    }
  }

  // One memoized post-order walk, so every node contributes to its ancestors once. Placement never
  // affects parentage, so cross-workspace descendants count. Archived nodes contribute no state of
  // their own but are still followed to any live child — a partial archive cannot hide work.
  const combinedByAgentId = new Map<string, SubagentActivity>();
  const visiting = new Set<string>();
  const combined = (agentId: string): SubagentActivity => {
    const memo = combinedByAgentId.get(agentId);
    if (memo !== undefined) {
      return memo;
    }
    // A malformed parent cycle must terminate; treat the re-entered edge as no signal.
    if (visiting.has(agentId)) {
      return "none";
    }
    visiting.add(agentId);
    const agent = agents.get(agentId);
    let activity: SubagentActivity = agent ? ownActivity(agent) : "none";
    for (const child of childrenByParentId.get(agentId) ?? []) {
      activity = mergeSubagentActivity(activity, combined(child.id));
    }
    visiting.delete(agentId);
    combinedByAgentId.set(agentId, activity);
    return activity;
  };

  const descendantsByAgentId = new Map<string, SubagentActivity>();
  for (const agentId of agents.keys()) {
    let activity: SubagentActivity = "none";
    for (const child of childrenByParentId.get(agentId) ?? []) {
      activity = mergeSubagentActivity(activity, combined(child.id));
    }
    descendantsByAgentId.set(agentId, activity);
  }

  return { childrenByParentId, descendantsByAgentId };
}

/**
 * A node's own contribution. Mirrors `workspaceAgentStatus` in `workspace-agent-activity.ts`: an
 * open turn is running before the lifecycle catches up, and a stale `running` lifecycle with no
 * open turn does not count as work. An idle node with no active child contributes nothing, so a
 * finished historical child cannot pin its parent to "waiting" forever.
 */
function ownActivity(agent: Agent): SubagentActivity {
  if (agent.archivedAt) {
    return "none";
  }
  // Optional chain: a partial snapshot must fail toward "no signal", not throw and blank the row.
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") {
    return "blocked";
  }
  if (agent.turn?.phase === "open") {
    return "active";
  }
  const status = agent.status === "running" ? "idle" : agent.status;
  return status === "initializing" ? "active" : "none";
}

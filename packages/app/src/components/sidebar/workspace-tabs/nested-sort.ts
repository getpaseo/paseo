import type { WorkspaceSort } from "@/projects/workspace-structure";
import type { WorkspaceDescriptor } from "@/stores/session-store";

/** The clocks a sidebar sort reads. Missing dates are already resolved to numbers. */
export interface WorkspaceSortClock {
  createdAt: number;
  /** Last human prompt, or the creation time when the workspace has none. */
  lastPromptAt: number;
  statusEnteredAt: number | null;
}

export interface AgentSortClock {
  createdAt: number;
  lastPromptAt: number;
  /** `${serverId}:${workspaceId}` when the agent has a workspace. */
  workspaceKey: string | null;
}

export function workspaceSortClock(workspace: WorkspaceDescriptor): WorkspaceSortClock {
  const createdAt = workspace.createdAt?.getTime() ?? 0;
  return {
    createdAt,
    lastPromptAt: workspace.lastUserMessageAt?.getTime() ?? createdAt,
    statusEnteredAt: workspace.statusEnteredAt?.getTime() ?? null,
  };
}

/**
 * The latest time each parent inherits from workspaces nested under it. A child with no time
 * contributes nothing, so a missing clock cannot pull a parent backward.
 */
export function childTimesByParent(
  parentsByKey: ReadonlyMap<string, readonly string[]>,
  timeOf: (workspaceKey: string) => number | null,
): ReadonlyMap<string, number> {
  const byParent = new Map<string, number>();
  for (const [child, parents] of parentsByKey) {
    const time = timeOf(child);
    if (time === null) continue;
    for (const parent of parents) {
      const current = byParent.get(parent);
      if (current === undefined || time > current) byParent.set(parent, time);
    }
  }
  return byParent;
}

/**
 * Drops nested workspace keys and, for Created and Last prompt, reorders what remains so a
 * parent sorts as recently as its newest nested workspace. Manual order and the name order
 * used when no sort is active only lose the hidden keys.
 */
export function orderWorkspaceKeys(
  workspaceKeys: readonly string[],
  nestedKeys: ReadonlySet<string>,
  sort: WorkspaceSort | undefined,
  timeOf: (workspaceKey: string) => number,
  childTimeByParent: ReadonlyMap<string, number>,
): readonly string[] {
  let hidesNested = false;
  for (const key of workspaceKeys) {
    if (nestedKeys.has(key)) {
      hidesNested = true;
      break;
    }
  }
  if (!hidesNested) return workspaceKeys;
  const visible = workspaceKeys.filter((key) => !nestedKeys.has(key));
  if (sort !== "created" && sort !== "lastPrompt") return visible;
  const ordered = [...visible].sort((left, right) => {
    const leftTime = effectiveSortTime(left, timeOf, childTimeByParent);
    const rightTime = effectiveSortTime(right, timeOf, childTimeByParent);
    return rightTime - leftTime || left.localeCompare(right);
  });
  return sameKeys(visible, ordered) ? visible : ordered;
}

export function effectiveSortTime(
  workspaceKey: string,
  timeOf: (workspaceKey: string) => number,
  childTimeByParent: ReadonlyMap<string, number>,
): number {
  const own = timeOf(workspaceKey);
  const child = childTimeByParent.get(workspaceKey);
  return child === undefined ? own : Math.max(own, child);
}

/** Newest first. Manual keeps the order the subagent track already uses. */
export function orderSidebarSubagentRows<T extends { id: string }>(
  rows: readonly T[],
  sort: WorkspaceSort,
  timeOf: (row: T) => number,
): readonly T[] {
  if (sort === "manual" || rows.length < 2) return rows;
  return [...rows].sort(
    (left, right) => timeOf(right) - timeOf(left) || left.id.localeCompare(right.id),
  );
}

export interface SidebarSubagentSortRow {
  id: string;
  kind: "paseo" | "provider";
  createdAt: Date;
  address?: { serverId: string };
}

/**
 * A subagent listed under a tab. One that has its own workspace sorts by that workspace's
 * clock, the same clock the workspace row would have used. One that shares the listing
 * workspace sorts by its own prompt, so siblings do not all inherit the parent's.
 * Provider subagents have no workspace and no prompt time.
 */
export function sidebarSubagentSortTime(input: {
  row: SidebarSubagentSortRow;
  sort: WorkspaceSort;
  listingWorkspaceKey: string;
  agents: ReadonlyMap<string, AgentSortClock>;
  workspaces: ReadonlyMap<string, WorkspaceSortClock>;
}): number {
  const { row, sort, listingWorkspaceKey, agents, workspaces } = input;
  if (row.kind !== "paseo" || !row.address) return row.createdAt.getTime();
  const agent = agents.get(`${row.address.serverId}:${row.id}`);
  if (!agent) return row.createdAt.getTime();
  const clock =
    agent.workspaceKey !== null && agent.workspaceKey !== listingWorkspaceKey
      ? workspaces.get(agent.workspaceKey)
      : undefined;
  if (sort === "created") return clock?.createdAt ?? agent.createdAt;
  return clock?.lastPromptAt ?? agent.lastPromptAt;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

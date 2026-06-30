import type { TFunction } from "i18next";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export type DateSectionKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

export const DATE_SECTION_ORDER = [
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "older",
] as const satisfies readonly DateSectionKey[];

export type FlatListItem =
  | { type: "header"; key: string; section: DateSectionKey }
  | {
      type: "agent";
      key: string;
      agent: AggregatedAgent;
      depth: number;
      hasChildren: boolean;
      expanded: boolean;
      childCount: number;
    };

export function deriveDateSectionKey(lastActivityAt: Date): DateSectionKey {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const activityStart = new Date(
    lastActivityAt.getFullYear(),
    lastActivityAt.getMonth(),
    lastActivityAt.getDate(),
  );

  if (activityStart.getTime() >= todayStart.getTime()) {
    return "today";
  }
  if (activityStart.getTime() >= yesterdayStart.getTime()) {
    return "yesterday";
  }

  const diffTime = todayStart.getTime() - activityStart.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) {
    return "thisWeek";
  }
  if (diffDays <= 30) {
    return "thisMonth";
  }
  return "older";
}

export function formatDateSectionLabel(t: TFunction, section: DateSectionKey): string {
  switch (section) {
    case "today":
      return t("agentList.dateSections.today");
    case "yesterday":
      return t("agentList.dateSections.yesterday");
    case "thisWeek":
      return t("agentList.dateSections.thisWeek");
    case "thisMonth":
      return t("agentList.dateSections.thisMonth");
    case "older":
      return t("agentList.dateSections.older");
  }
}

// Group agents into a parent -> children forest. A child is an agent whose
// parent label resolves to another agent on the same server; everything else
// (no label, or parent absent from the list) is a root. Nesting depth is
// unbounded — the render walks the forest recursively.
function groupAgentsByParent(agents: AggregatedAgent[]): {
  childrenByParentKey: Map<string, AggregatedAgent[]>;
  rootAgents: AggregatedAgent[];
} {
  // Fast lookup of agent ids present per server.
  const agentIdsByServer = new Map<string, Set<string>>();
  for (const agent of agents) {
    const serverSet = agentIdsByServer.get(agent.serverId) ?? new Set<string>();
    serverSet.add(agent.id);
    agentIdsByServer.set(agent.serverId, serverSet);
  }

  const childrenByParentKey = new Map<string, AggregatedAgent[]>();
  const rootAgents: AggregatedAgent[] = [];
  for (const agent of agents) {
    const parentId = getParentAgentIdFromLabels(agent.labels);
    const hasParentInList =
      parentId !== null && agentIdsByServer.get(agent.serverId)?.has(parentId) === true;
    if (!hasParentInList) {
      rootAgents.push(agent);
      continue;
    }
    const parentKey = `${agent.serverId}:${parentId}`;
    const siblings = childrenByParentKey.get(parentKey) ?? [];
    siblings.push(agent);
    childrenByParentKey.set(parentKey, siblings);
  }

  // Sort siblings by createdAt asc (mirrors selectSubagentsForParent ordering).
  for (const siblings of childrenByParentKey.values()) {
    siblings.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  return { childrenByParentKey, rootAgents };
}

// Keys reachable from any root by walking the children map (expand-independent).
// Agents outside this set are only reachable via a parent-label cycle.
function collectReachableKeys(
  rootAgents: AggregatedAgent[],
  childrenByParentKey: Map<string, AggregatedAgent[]>,
): Set<string> {
  const reachable = new Set<string>();
  const stack = rootAgents.map((agent) => `${agent.serverId}:${agent.id}`);
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || reachable.has(key)) continue;
    reachable.add(key);
    for (const child of childrenByParentKey.get(key) ?? []) {
      stack.push(`${child.serverId}:${child.id}`);
    }
  }
  return reachable;
}

export function buildFlatItems(
  agents: AggregatedAgent[],
  expandedParents: ReadonlySet<string>,
): FlatListItem[] {
  const { childrenByParentKey, rootAgents } = groupAgentsByParent(agents);
  const reachable = collectReachableKeys(rootAgents, childrenByParentKey);

  const result: FlatListItem[] = [];
  const emitted = new Set<string>();

  // Emit an agent and, when expanded, its descendants at increasing depth.
  // `emitted` guards against duplicates and parent-label cycles (A <- B <- A),
  // so the walk always terminates and never renders an agent twice.
  const emitAgent = (agent: AggregatedAgent, depth: number): void => {
    const key = `${agent.serverId}:${agent.id}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    const children = childrenByParentKey.get(key) ?? [];
    const hasChildren = children.length > 0;
    const expanded = hasChildren && expandedParents.has(key);
    result.push({
      type: "agent",
      key,
      agent,
      depth,
      hasChildren,
      expanded,
      childCount: children.length,
    });
    if (!expanded) return;
    for (const child of children) {
      emitAgent(child, depth + 1);
    }
  };

  // Date-section headers apply to roots only; descendants nest under their root.
  const buckets = new Map<DateSectionKey, AggregatedAgent[]>();
  for (const agent of rootAgents) {
    const section = deriveDateSectionKey(agent.lastActivityAt);
    const existing = buckets.get(section) ?? [];
    existing.push(agent);
    buckets.set(section, existing);
  }

  for (const section of DATE_SECTION_ORDER) {
    const data = buckets.get(section);
    if (!data || data.length === 0) continue;
    result.push({ type: "header", key: `header:${section}`, section });
    for (const agent of data) {
      emitAgent(agent, 0);
    }
  }

  // Safety net: an agent unreachable from any root (only possible via a
  // parent-label cycle) still renders top-level so it is never silently dropped.
  // Reachable descendants of a collapsed parent stay hidden — they are reachable.
  for (const agent of agents) {
    if (reachable.has(`${agent.serverId}:${agent.id}`)) continue;
    emitAgent(agent, 0);
  }

  return result;
}

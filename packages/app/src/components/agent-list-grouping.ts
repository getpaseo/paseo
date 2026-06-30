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
      depth: 0 | 1;
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

/**
 * Pure function — exported for unit testing.
 * Builds the flat item list for the FlatList, grouping children under parents.
 * - Children are agents whose derived parentAgentId matches another agent.id on the same serverId.
 * - Orphan children (parent absent from `agents`) render as normal top-level rows.
 * - Date-section headers apply to top-level rows only.
 * - Children of an expanded parent appear immediately after the parent, sorted by createdAt asc.
 */
export function buildFlatItems(
  agents: AggregatedAgent[],
  expandedParents: ReadonlySet<string>,
): FlatListItem[] {
  // Fast lookup of agent ids present per server
  const agentIdsByServer = new Map<string, Set<string>>();
  for (const agent of agents) {
    const serverSet = agentIdsByServer.get(agent.serverId) ?? new Set<string>();
    serverSet.add(agent.id);
    agentIdsByServer.set(agent.serverId, serverSet);
  }

  // Group children under their parents (orphans are excluded and remain top-level)
  const childrenByParentKey = new Map<string, AggregatedAgent[]>();
  const childAgentKeys = new Set<string>();

  for (const agent of agents) {
    const parentId = getParentAgentIdFromLabels(agent.labels);
    if (parentId === null) continue;
    const serverSet = agentIdsByServer.get(agent.serverId);
    // Orphan: parent not in this server's agent list → stays top-level
    if (!serverSet?.has(parentId)) continue;
    const parentKey = `${agent.serverId}:${parentId}`;
    const childKey = `${agent.serverId}:${agent.id}`;
    childAgentKeys.add(childKey);
    const siblings = childrenByParentKey.get(parentKey) ?? [];
    siblings.push(agent);
    childrenByParentKey.set(parentKey, siblings);
  }

  // Sort children by createdAt ascending (mirrors selectSubagentsForParent ordering)
  for (const siblings of childrenByParentKey.values()) {
    siblings.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // Bucket top-level agents by date section
  const buckets = new Map<DateSectionKey, AggregatedAgent[]>();
  for (const agent of agents) {
    if (childAgentKeys.has(`${agent.serverId}:${agent.id}`)) continue;
    const section = deriveDateSectionKey(agent.lastActivityAt);
    const existing = buckets.get(section) ?? [];
    existing.push(agent);
    buckets.set(section, existing);
  }

  const result: FlatListItem[] = [];
  for (const section of DATE_SECTION_ORDER) {
    const data = buckets.get(section);
    if (!data || data.length === 0) continue;
    result.push({ type: "header", key: `header:${section}`, section });
    for (const agent of data) {
      const agentKey = `${agent.serverId}:${agent.id}`;
      const children = childrenByParentKey.get(agentKey) ?? [];
      const hasChildren = children.length > 0;
      const expanded = hasChildren && expandedParents.has(agentKey);
      result.push({
        type: "agent",
        key: agentKey,
        agent,
        depth: 0,
        hasChildren,
        expanded,
        childCount: children.length,
      });
      if (expanded) {
        for (const child of children) {
          result.push({
            type: "agent",
            key: `${child.serverId}:${child.id}`,
            agent: child,
            depth: 1,
            hasChildren: false,
            expanded: false,
            childCount: 0,
          });
        }
      }
    }
  }
  return result;
}

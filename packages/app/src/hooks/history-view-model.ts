import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  compareAgentHistoryText,
  normalizeAgentHistoryTitle,
} from "@getpaseo/protocol/agent-history-sort";
import type {
  HistoryGroupMode,
  HistoryLastActivityFilter,
  HistorySortMode,
  HistoryStatusFilter,
} from "@/stores/history-view-store";

export type HistoryDateSectionKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

export type HistorySection =
  | { key: "pinned"; kind: "pinned"; agents: AggregatedAgent[] }
  | {
      key: `date:${HistoryDateSectionKey}`;
      kind: "date";
      dateKey: HistoryDateSectionKey;
      agents: AggregatedAgent[];
    }
  | {
      key: `project:${string}`;
      kind: "project";
      title: string;
      agents: AggregatedAgent[];
    }
  | { key: "all"; kind: "none"; agents: AggregatedAgent[] };

export interface HistoryServerFilter {
  archiveState: HistoryStatusFilter;
  includeArchived: boolean;
  projectKeys?: string[];
  updatedAfter?: string;
}

export type HistoryServerSort = Array<{
  key: "pinned" | "created_at" | "updated_at" | "title";
  direction: "asc" | "desc";
}>;

export interface HistoryServerQuery {
  filter: HistoryServerFilter;
  sort: HistoryServerSort;
}

const DATE_SECTION_ORDER = [
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "older",
] as const satisfies readonly HistoryDateSectionKey[];

function localDayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function localCalendarDayOrdinal(value: Date): number {
  return Math.trunc(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);
}

export function historyUpdatedAfter(
  filter: HistoryLastActivityFilter,
  now: Date,
): string | undefined {
  if (filter === "any") return undefined;
  const start = localDayStart(now);
  let calendarDays = 30;
  if (filter === "today") calendarDays = 1;
  else if (filter === "7d") calendarDays = 7;
  start.setDate(start.getDate() - (calendarDays - 1));
  return start.toISOString();
}

export function buildHistoryServerQuery(input: {
  status: HistoryStatusFilter;
  projectFilters: readonly string[];
  lastActivity: HistoryLastActivityFilter;
  sortMode: HistorySortMode;
  now: Date;
}): HistoryServerQuery {
  const projectKeys = [
    ...new Set(input.projectFilters.map((key) => key.trim()).filter(Boolean)),
  ].sort();
  const updatedAfter = historyUpdatedAfter(input.lastActivity, input.now);
  let userSort: HistoryServerSort[number] = { key: "updated_at", direction: "desc" };
  if (input.sortMode === "alphabetical") userSort = { key: "title", direction: "asc" };
  else if (input.sortMode === "created") userSort = { key: "created_at", direction: "desc" };

  return {
    filter: {
      archiveState: input.status,
      includeArchived: input.status !== "active",
      ...(projectKeys.length > 0 ? { projectKeys } : {}),
      ...(updatedAfter ? { updatedAfter } : {}),
    },
    sort: [{ key: "pinned", direction: "desc" }, userSort],
  };
}

function compareTitles(left: AggregatedAgent, right: AggregatedAgent): number {
  return compareAgentHistoryText(
    normalizeAgentHistoryTitle(left.title),
    normalizeAgentHistoryTitle(right.title),
  );
}

function compareStableIdentity(left: AggregatedAgent, right: AggregatedAgent): number {
  const server = compareAgentHistoryText(left.serverId, right.serverId);
  return server !== 0 ? server : compareAgentHistoryText(left.id, right.id);
}

export function compareHistoryAgents(
  left: AggregatedAgent,
  right: AggregatedAgent,
  sortMode: HistorySortMode,
): number {
  const pinOrder = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt));
  if (pinOrder !== 0) return pinOrder;

  let order = 0;
  if (sortMode === "alphabetical") {
    order = compareTitles(left, right);
  } else if (sortMode === "created") {
    order = right.createdAt.getTime() - left.createdAt.getTime();
  } else {
    order = right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  }
  if (order !== 0) return order;

  const titleOrder = compareTitles(left, right);
  return titleOrder !== 0 ? titleOrder : compareStableIdentity(left, right);
}

export function dedupeAndSortHistoryAgents(
  agents: readonly AggregatedAgent[],
  sortMode: HistorySortMode,
): AggregatedAgent[] {
  const unique = new Map<string, AggregatedAgent>();
  for (const agent of agents) {
    unique.set(`${agent.serverId}:${agent.id}`, agent);
  }
  return [...unique.values()].sort((left, right) => compareHistoryAgents(left, right, sortMode));
}

export function filterHistoryAgents(
  agents: readonly AggregatedAgent[],
  filter: HistoryServerFilter,
): AggregatedAgent[] {
  const projectKeys = new Set(filter.projectKeys ?? []);
  const updatedAfter = filter.updatedAfter ? new Date(filter.updatedAfter).getTime() : null;
  return agents.filter((agent) => {
    if (filter.archiveState === "active" && agent.archivedAt) return false;
    if (filter.archiveState === "archived" && !agent.archivedAt) return false;
    if (
      projectKeys.size > 0 &&
      (!agent.projectPlacement?.projectKey || !projectKeys.has(agent.projectPlacement.projectKey))
    ) {
      return false;
    }
    if (updatedAfter !== null && agent.lastActivityAt.getTime() < updatedAfter) return false;
    return true;
  });
}

function deriveDateSectionKey(lastActivityAt: Date, now: Date): HistoryDateSectionKey {
  // Compare calendar ordinals rather than elapsed local-midnight milliseconds;
  // DST transitions make some local days 23 or 25 hours long.
  const diffDays = localCalendarDayOrdinal(now) - localCalendarDayOrdinal(lastActivityAt);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "thisWeek";
  if (diffDays <= 30) return "thisMonth";
  return "older";
}

function buildDateSections(agents: AggregatedAgent[], now: Date): HistorySection[] {
  const buckets = new Map<HistoryDateSectionKey, AggregatedAgent[]>();
  for (const agent of agents) {
    const key = deriveDateSectionKey(agent.lastActivityAt, now);
    const bucket = buckets.get(key) ?? [];
    bucket.push(agent);
    buckets.set(key, bucket);
  }
  return DATE_SECTION_ORDER.flatMap((dateKey) => {
    const bucket = buckets.get(dateKey);
    return bucket && bucket.length > 0
      ? [{ key: `date:${dateKey}`, kind: "date", dateKey, agents: bucket } as const]
      : [];
  });
}

function buildProjectSections(agents: AggregatedAgent[]): HistorySection[] {
  const buckets = new Map<string, { title: string; agents: AggregatedAgent[] }>();
  for (const agent of agents) {
    const projectKey = agent.projectPlacement?.projectKey?.trim() || "none";
    const title = agent.projectPlacement?.projectName?.trim() || "No project";
    const bucket = buckets.get(projectKey) ?? { title, agents: [] };
    bucket.agents.push(agent);
    buckets.set(projectKey, bucket);
  }
  return [...buckets.entries()]
    .sort((left, right) => compareAgentHistoryText(left[1].title, right[1].title))
    .map(([projectKey, bucket]) => ({
      key: `project:${projectKey}` as const,
      kind: "project" as const,
      title: bucket.title,
      agents: bucket.agents,
    }));
}

export function buildHistorySections(input: {
  agents: readonly AggregatedAgent[];
  groupMode: HistoryGroupMode;
  now: Date;
}): HistorySection[] {
  const pinned = input.agents.filter((agent) => Boolean(agent.pinnedAt));
  const regular = input.agents.filter((agent) => !agent.pinnedAt);
  const sections: HistorySection[] =
    pinned.length > 0 ? [{ key: "pinned", kind: "pinned", agents: pinned }] : [];

  if (regular.length === 0) return sections;
  if (input.groupMode === "none") {
    sections.push({ key: "all", kind: "none", agents: regular });
  } else if (input.groupMode === "project") {
    sections.push(...buildProjectSections(regular));
  } else {
    sections.push(...buildDateSections(regular, input.now));
  }
  return sections;
}

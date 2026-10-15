import { formatCompactTimeAgoAsProse } from "@/utils/time";
import { usageCopy } from "./copy";
import type { UsageDisplayAs } from "./preferences";
import type { UsageReportEntry, UsageView, UsageWindow } from "./types";

export function usedPercent(window: UsageWindow): number | null {
  if (window.usedPct != null) return window.usedPct;
  if (window.remainingPct != null) return 100 - window.remainingPct;
  return null;
}

/** The percent a window shows under the user's used/remaining preference. */
export function displayPercent(window: UsageWindow, displayAs: UsageDisplayAs): number | null {
  if (displayAs === "used") return usedPercent(window);
  if (window.remainingPct != null) return window.remainingPct;
  const used = usedPercent(window);
  return used == null ? null : 100 - used;
}

/**
 * A window row's accessible label: what pinning it pins, then what the row shows. The row is a
 * checkbox, so its checked state says whether it is pinned: "Pin Claude Session, 31% · resets in
 * 2h", checked.
 */
export function usageWindowRowLabel(input: {
  pinLabel: string;
  value: string;
  trailing: string | null | undefined;
}): string {
  const summary = input.trailing ? `${input.value} · ${input.trailing}` : input.value;
  return `${input.pinLabel}, ${summary}`;
}

/** When a report was fetched, from its compact relative time: "Updated 3m ago". */
export function formatUsageFreshness(compactTimeAgo: string): string {
  return `${usageCopy.updated} ${formatCompactTimeAgoAsProse(compactTimeAgo)}`;
}

/** A user-requested refresh of one report. The previous report stays on screen throughout. */
export type UsageRefresh = "idle" | "pending" | "failed";

export function resolveUsageRefresh(mutation: {
  isPending: boolean;
  error: unknown;
}): UsageRefresh {
  if (mutation.isPending) return "pending";
  if (mutation.error) return "failed";
  return "idle";
}

/**
 * A host's report list with one report swapped for its refreshed copy, in place.
 * `null` means the daemon no longer knows the ID, so the report leaves the list.
 */
export function replaceReport(
  reports: readonly UsageReportEntry[],
  reportId: string,
  refreshed: UsageReportEntry | null,
): UsageReportEntry[] {
  if (!refreshed) return reports.filter((report) => report.id !== reportId);
  return reports.map((report) => (report.id === reportId ? refreshed : report));
}

/**
 * The later-fetched of two copies of one report. A list request's copies were fetched when it
 * started, so a Refresh that lands while it streams is newer than what the request still delivers.
 */
function laterFetched(shown: UsageReportEntry, arriving: UsageReportEntry): UsageReportEntry {
  return Date.parse(shown.fetchedAt) > Date.parse(arriving.fetchedAt) ? shown : arriving;
}

/**
 * A report list with one streamed report in place of its previous copy, or appended if new. A
 * copy fetched after the streamed one stays.
 */
export function upsertReport(
  reports: readonly UsageReportEntry[] | undefined,
  report: UsageReportEntry,
): UsageReportEntry[] {
  if (!reports?.some((entry) => entry.id === report.id)) return [...(reports ?? []), report];
  return reports.map((entry) => (entry.id === report.id ? laterFetched(entry, report) : entry));
}

/**
 * The list a finished request leaves: its reports, dropping any the host no longer has, except
 * that a copy on screen fetched after the request's copy stays.
 */
export function settleReports(
  shown: readonly UsageReportEntry[] | undefined,
  finished: readonly UsageReportEntry[],
): UsageReportEntry[] {
  return finished.map((report) => {
    const copy = shown?.find((entry) => entry.id === report.id);
    return copy ? laterFetched(copy, report) : report;
  });
}

export interface UsageQueryState {
  data: UsageReportEntry[] | undefined;
  error: unknown;
  isFetching: boolean;
}

export function resolveUsageView(input: {
  hostLabel: string;
  isConnected: boolean;
  supportsUsage: boolean;
  query: UsageQueryState | undefined;
}): UsageView {
  const { hostLabel, isConnected, supportsUsage, query } = input;
  if (!isConnected) return { kind: "unavailable", message: usageCopy.hostUnavailable(hostLabel) };
  if (!supportsUsage) {
    return { kind: "unavailable", message: usageCopy.hostUpgradeRequired(hostLabel) };
  }
  if (query?.data) {
    return { kind: "ready", reports: query.data, isRefreshing: query.isFetching };
  }
  if (query?.error) {
    return {
      kind: "error",
      message: query.error instanceof Error ? query.error.message : String(query.error),
    };
  }
  return { kind: "loading" };
}

/** What a meter popover shows of its agent's usage: nothing while the host cannot say. */
export type AgentUsageView =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: UsageReportEntry[] };

export function resolveAgentUsageView(input: {
  canReport: boolean;
  query: UsageQueryState;
}): AgentUsageView {
  const { canReport, query } = input;
  if (!canReport) return { kind: "none" };
  // A failed request keeps the reports from before it, or those that streamed in before it failed;
  // shown alone they would pass for the agent's complete, current usage.
  if (query.error) {
    const reason = query.error instanceof Error ? query.error.message : String(query.error);
    return { kind: "error", message: usageCopy.agentError(reason) };
  }
  if (query.data) {
    return query.data.length === 0 ? { kind: "none" } : { kind: "ready", reports: query.data };
  }
  return { kind: "loading" };
}

export interface UsageHost {
  serverId: string;
  label: string;
  isConnected: boolean;
  supportsUsage: boolean;
}

/** Where usage looks for its host: the user's saved pick, then the workspace they are in. */
export interface UsageHostChoice {
  pickedServerId: string | null;
  activeServerId: string | null;
  hosts: readonly UsageHost[];
}

/**
 * The host the sidebar Usage row reads: the picked host, else the active workspace's host, else the
 * first host. Each only while it is connected and reports usage.
 */
export function resolveUsageHostId(choice: UsageHostChoice): string | null {
  const reporting = choice.hosts.filter((host) => host.isConnected && host.supportsUsage);
  const find = (serverId: string | null) => reporting.find((host) => host.serverId === serverId);
  return (
    (find(choice.pickedServerId) ?? find(choice.activeServerId) ?? reporting[0])?.serverId ?? null
  );
}

/**
 * The host the Usage modal shows: the picked host while it is connected, even one that cannot
 * report usage so the modal says to update it; else the sidebar row's host; else the first
 * connected host.
 */
export function resolveUsageModalHostId(choice: UsageHostChoice): string | null {
  const connected = choice.hosts.filter((host) => host.isConnected);
  const picked = connected.find((host) => host.serverId === choice.pickedServerId);
  return picked?.serverId ?? resolveUsageHostId(choice) ?? connected[0]?.serverId ?? null;
}

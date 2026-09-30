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

export interface UsageHost {
  serverId: string;
  label: string;
  isConnected: boolean;
  supportsUsage: boolean;
}

/**
 * The host usage shows by default, on the sidebar row and the Usage screen: the active workspace's
 * host if it reports usage, else the first host that does.
 */
export function resolveUsageHostId(
  activeServerId: string | null,
  hosts: readonly UsageHost[],
): string | null {
  const reporting = hosts.filter((host) => host.isConnected && host.supportsUsage);
  const active = reporting.find((host) => host.serverId === activeServerId);
  return (active ?? reporting[0])?.serverId ?? null;
}

/**
 * The host the Usage screen shows: the user's pick while it stays connected, else the default
 * host. With no host reporting usage, the first connected host, so the screen says to update it.
 */
export function resolveUsageScreenHostId(input: {
  selectedServerId: string | null;
  activeServerId: string | null;
  hosts: readonly UsageHost[];
}): string | null {
  const connected = input.hosts.filter((host) => host.isConnected);
  const selected = connected.find((host) => host.serverId === input.selectedServerId);
  return (
    selected?.serverId ??
    resolveUsageHostId(input.activeServerId, input.hosts) ??
    connected[0]?.serverId ??
    null
  );
}

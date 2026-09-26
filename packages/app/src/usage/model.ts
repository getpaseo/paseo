import { usageCopy } from "./copy";
import type { UsageReport, UsageReportEntry, UsageView, UsageWindow } from "./types";

export function usedPercent(window: UsageWindow): number | null {
  if (window.usedPct != null) return window.usedPct;
  if (window.remainingPct != null) return 100 - window.remainingPct;
  return null;
}

/** The window the source marked as its headline. Sources own that choice; there is no fallback. */
export function headlineWindow(report: UsageReport): UsageWindow | null {
  return report.windows.find((window) => window.headline === true) ?? null;
}

export interface UsagePill {
  icon: string | null;
  sourceLabel: string;
  /** Headline percent, else the plan label, else nothing beside the icon. */
  text: string | null;
}

export function resolveUsagePill(input: {
  supportsUsage: boolean;
  entry: UsageReportEntry | null | undefined;
}): UsagePill | null {
  const { supportsUsage, entry } = input;
  if (!supportsUsage || !entry) return null;
  const window = headlineWindow(entry.report);
  const percent = window ? usedPercent(window) : null;
  return {
    icon: entry.icon ?? null,
    sourceLabel: entry.sourceLabel,
    text:
      percent != null
        ? `${Math.round(Math.max(0, Math.min(100, percent)))}%`
        : (entry.report.planLabel ?? null),
  };
}

export interface UsageQueryState {
  data: UsageReportEntry[] | undefined;
  error: unknown;
  isFetching: boolean;
}

export function resolveUsageView(input: {
  isConnected: boolean;
  supportsUsage: boolean;
  query: UsageQueryState | undefined;
}): UsageView {
  const { isConnected, supportsUsage, query } = input;
  if (!isConnected) return { kind: "unavailable", message: usageCopy.hostUnavailable };
  if (!supportsUsage) return { kind: "unavailable", message: usageCopy.hostUpgradeRequired };
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

export interface UsageHostGroup {
  serverId: string;
  label: string;
  view: UsageView;
}

/** One group per connected host, in host order. */
export function groupUsageByHost(
  hosts: readonly UsageHost[],
  queries: ReadonlyMap<string, UsageQueryState>,
): UsageHostGroup[] {
  return hosts
    .filter((host) => host.isConnected)
    .map((host) => ({
      serverId: host.serverId,
      label: host.label,
      view: resolveUsageView({
        isConnected: true,
        supportsUsage: host.supportsUsage,
        query: queries.get(host.serverId),
      }),
    }));
}

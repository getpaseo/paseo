import type { UsageProblem } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { formatCompactTimeAgo, formatCompactTimeAgoAsProse } from "@/utils/time";

// User-facing copy for the usage surfaces, kept in one file so localization is a
// single-file change.
export const usageCopy = {
  problem: (problem: UsageProblem, now: Date = new Date()): string => {
    if (problem.kind === "no_quota") return problem.detail;
    const remedy = problem.refreshedBy
      ? `Run ${problem.refreshedBy} to refresh it.`
      : "Sign in again.";
    if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
    const ago = formatCompactTimeAgoAsProse(formatCompactTimeAgo(new Date(problem.expiresAt), now));
    return `Login expired ${ago}. ${remedy}`;
  },
  get title() {
    return i18n.t("providerUsage.title");
  },
  get planUsage() {
    return i18n.t("providerUsage.title");
  },
  options: "Settings",
  get refresh() {
    return i18n.t("providerUsage.refresh");
  },
  get refreshAll() {
    return i18n.t("providerUsage.refreshAll");
  },
  get refreshing() {
    return i18n.t("providerUsage.refreshing");
  },
  refreshFailed: "Unable to refresh usage",
  updated: "Updated",
  get loading() {
    return i18n.t("providerUsage.loading");
  },
  get empty() {
    return i18n.t("providerUsage.empty");
  },
  noHosts: "No connected hosts",
  get errorTitle() {
    return i18n.t("providerUsage.errorTitle");
  },
  agentError: (reason: string) => `Unable to load usage: ${reason}`,
  hostUnavailable: (host: string) => `Connect to ${host} to see usage`,
  hostUpgradeRequired: (host: string) => `Update ${host} to see usage`,
  clientUnavailable: "Host connection is not ready",
  get retry() {
    return i18n.t("providerUsage.retry");
  },
  pin: "Pin",
  unpin: "Unpin",
  displayAs: "Percentages",
  displayUsed: "Used",
  displayRemaining: "Remaining",
  showInSidebar: "Summary in sidebar",
  showInSidebarHint: "Pinned windows show in the sidebar footer",
} as const;

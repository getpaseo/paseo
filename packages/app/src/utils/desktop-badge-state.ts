import type { WorkspaceDescriptor } from "@/stores/session-store";

export type DesktopBadgeWorkspaceStatus = WorkspaceDescriptor["status"];

export function isWorkspaceActionableForDesktopBadge(status: DesktopBadgeWorkspaceStatus): boolean {
  return status === "attention" || status === "needs_input" || status === "failed";
}

export function deriveMacDockBadgeCountFromWorkspaceStatuses(
  statuses: readonly DesktopBadgeWorkspaceStatus[],
): number | undefined {
  const actionableCount = statuses.filter(isWorkspaceActionableForDesktopBadge).length;
  return actionableCount > 0 ? actionableCount : undefined;
}

import type { WorkspaceDescriptor } from "@/stores/session-store";

export type DesktopBadgeWorkspaceStatus = WorkspaceDescriptor["status"];

interface WorkspaceStatusSource {
  sessions: Record<string, { workspaces: ReadonlyMap<string, WorkspaceDescriptor> } | undefined>;
}

export function isWorkspaceActionableForDesktopBadge(status: DesktopBadgeWorkspaceStatus): boolean {
  return status === "attention" || status === "needs_input" || status === "failed";
}

/**
 * The macOS dock badge only needs a count, so count here instead of materialising every
 * workspace status and comparing the whole list on every store write.
 */
export function selectMacDockBadgeCount(state: WorkspaceStatusSource): number | undefined {
  let actionableCount = 0;
  for (const session of Object.values(state.sessions)) {
    if (!session) continue;
    for (const workspace of session.workspaces.values()) {
      if (isWorkspaceActionableForDesktopBadge(workspace.status)) actionableCount += 1;
    }
  }
  return actionableCount > 0 ? actionableCount : undefined;
}

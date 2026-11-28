import type { WorkspaceDescriptor } from "@/stores/session-store";
import { memoizeOnSessionMaps } from "./memoize-on-session-maps";

export type DesktopBadgeWorkspaceStatus = WorkspaceDescriptor["status"];

interface WorkspaceStatusSession {
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
}

interface WorkspaceStatusSource {
  sessions: Record<string, WorkspaceStatusSession | undefined>;
}

export function isWorkspaceActionableForDesktopBadge(status: DesktopBadgeWorkspaceStatus): boolean {
  return status === "attention" || status === "needs_input" || status === "failed";
}

/**
 * The macOS dock badge only needs a count, so count here instead of materialising every
 * workspace status and comparing the whole list on every store write.
 */
export interface DockBadgeOptions {
  /** Count background workspaces too, as the sidebar shows them while Show background is on. */
  showBackground?: boolean;
}

export function selectMacDockBadgeCount(
  state: WorkspaceStatusSource,
  options: DockBadgeOptions = {},
): number | undefined {
  let actionableCount = 0;
  for (const session of Object.values(state.sessions)) {
    if (!session) continue;
    for (const workspace of session.workspaces.values()) {
      // A hidden background workspace would leave the badge pointing at nothing in the sidebar.
      if (workspace.background && !options.showBackground) continue;
      if (isWorkspaceActionableForDesktopBadge(workspace.status)) actionableCount += 1;
    }
  }
  return actionableCount > 0 ? actionableCount : undefined;
}

/** A session-store selector for the dock badge count that recounts only when a workspace map changes. */
export function createMacDockBadgeCountSelector(
  options: DockBadgeOptions = {},
): (state: WorkspaceStatusSource) => number | undefined {
  return memoizeOnSessionMaps<WorkspaceStatusSession, WorkspaceStatusSource, number | undefined>(
    (session) => [session.workspaces],
    (state) => selectMacDockBadgeCount(state, options),
  );
}

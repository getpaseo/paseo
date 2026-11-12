import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";

/**
 * Whether the slot to the right of a workspace title has anything to draw for this workspace
 * under the current preference. Lives beside the renderers but imports none of them, so the
 * availability rules stay testable without mounting the React tree.
 */
export function hasSidebarWorkspaceTrailing({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}): boolean {
  if (trailing === "diff") return workspace.diffStat !== null;
  if (trailing === "timestamp") return workspace.statusEnteredAt !== null;
  return trailing === "agentStatus";
}

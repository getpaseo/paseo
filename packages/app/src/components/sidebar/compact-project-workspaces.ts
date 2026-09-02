import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { aggregateSidebarStateBuckets } from "@/utils/sidebar-agent-state";

interface WorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

export interface CompactProjectWorkspaceTarget {
  key: string;
  workspace: SidebarWorkspaceEntry;
  statusBucket: SidebarWorkspaceEntry["statusBucket"];
  selected: boolean;
}

interface TargetGroup {
  key: string;
  workspaces: SidebarWorkspaceEntry[];
}

function isSelected(
  workspace: SidebarWorkspaceEntry,
  selection: WorkspaceSelection | null,
): boolean {
  return (
    workspace.serverId === selection?.serverId && workspace.workspaceId === selection.workspaceId
  );
}

function enteredAt(workspace: SidebarWorkspaceEntry): number {
  return workspace.statusEnteredAt?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function pickLatest(workspaces: SidebarWorkspaceEntry[]): SidebarWorkspaceEntry {
  return workspaces.reduce((latest, workspace) =>
    enteredAt(workspace) > enteredAt(latest) ? workspace : latest,
  );
}

export function buildCompactProjectWorkspaceTargets(input: {
  workspaces: SidebarWorkspaceEntry[];
  selection: WorkspaceSelection | null;
}): CompactProjectWorkspaceTarget[] {
  const groups = new Map<string, TargetGroup>();

  for (const workspace of input.workspaces) {
    // Compact mode exposes one work target and one schedule target per project. Rows mode
    // still exposes every underlying workspace and schedule run.
    const kind = workspace.scheduleId ? "schedule" : "work";
    const key = `project:${workspace.projectViewKey}:${kind}`;
    const group = groups.get(key);
    if (group) {
      group.workspaces.push(workspace);
    } else {
      groups.set(key, { key, workspaces: [workspace] });
    }
  }

  return Array.from(groups.values(), (group) => {
    const statusBucket = aggregateSidebarStateBuckets(
      group.workspaces.map((workspace) => workspace.statusBucket),
    );
    const selectedWorkspace = group.workspaces.find((workspace) =>
      isSelected(workspace, input.selection),
    );
    const statusCandidates = group.workspaces.filter(
      (workspace) => workspace.statusBucket === statusBucket,
    );
    const workspace = selectedWorkspace ?? pickLatest(statusCandidates);
    return {
      key: group.key,
      workspace,
      statusBucket,
      selected: selectedWorkspace !== undefined,
    };
  });
}

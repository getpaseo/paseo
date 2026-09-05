import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceArchiveFailure } from "@/workspace/workspace-archive";

export function workspaceTargetKey(input: { serverId: string; workspaceId: string }): string {
  return `${input.serverId}:${input.workspaceId}`;
}

export function toggleWorkspaceSelection(
  selectedWorkspaceKeys: ReadonlySet<string>,
  workspaceKey: string,
): Set<string> {
  const next = new Set(selectedWorkspaceKeys);
  if (next.has(workspaceKey)) {
    next.delete(workspaceKey);
  } else {
    next.add(workspaceKey);
  }
  return next;
}

export function reconcileWorkspaceSelection(
  selectedWorkspaceKeys: ReadonlySet<string>,
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>,
): Set<string> {
  return new Set(
    [...selectedWorkspaceKeys].filter((workspaceKey) => workspaceEntriesByKey.has(workspaceKey)),
  );
}

export function selectAvailableWorkspaceKeys(
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>,
): Set<string> {
  return new Set(
    [...workspaceEntriesByKey.entries()].flatMap(([workspaceKey, workspace]) =>
      workspace.archivingAt === null ? [workspaceKey] : [],
    ),
  );
}

export function resolveRemainingWorkspaceSelection(input: {
  selectedWorkspaceKeys: ReadonlySet<string>;
  confirmedWorkspaceKeys: ReadonlySet<string>;
  failures: readonly WorkspaceArchiveFailure[];
}): Set<string> {
  const failedWorkspaceKeys = new Set(input.failures.map(workspaceTargetKey));
  return new Set(
    [...input.selectedWorkspaceKeys].filter(
      (workspaceKey) =>
        !input.confirmedWorkspaceKeys.has(workspaceKey) || failedWorkspaceKeys.has(workspaceKey),
    ),
  );
}

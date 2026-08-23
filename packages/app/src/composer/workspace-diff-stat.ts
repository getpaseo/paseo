import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

type DiffStat = NonNullable<WorkspaceDescriptor["diffStat"]>;

export function useVisibleWorkspaceDiffStat(
  serverId: string,
  workspaceId: string,
): DiffStat | null {
  const diffStat = useWorkspaceFields(serverId, workspaceId, (workspace) => workspace.diffStat);
  return hasDiffStatChanges(diffStat) ? diffStat : null;
}

export function useWorkspaceHasDiffStat(serverId: string, workspaceId: string): boolean {
  return (
    useWorkspaceFields(serverId, workspaceId, (workspace) =>
      hasDiffStatChanges(workspace.diffStat),
    ) ?? false
  );
}

function hasDiffStatChanges(diffStat: WorkspaceDescriptor["diffStat"]): diffStat is DiffStat {
  return Boolean(diffStat && (diffStat.additions > 0 || diffStat.deletions > 0));
}

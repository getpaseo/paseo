import { confirmRiskyWorktreeArchive, toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceArchiveTarget } from "@/workspace/workspace-archive";

export interface ProjectWorkspaceArchiveEntry extends Pick<
  SidebarWorkspaceEntry,
  | "serverId"
  | "workspaceId"
  | "workspaceKind"
  | "name"
  | "archiveHasUncommittedChanges"
  | "archiveUnpushedCommitCount"
  | "diffStat"
> {}

type ConfirmWorktreeArchive = typeof confirmRiskyWorktreeArchive;

export async function selectProjectWorkspacesToArchive(
  workspaces: ProjectWorkspaceArchiveEntry[],
  confirmWorktreeArchive: ConfirmWorktreeArchive = confirmRiskyWorktreeArchive,
): Promise<WorkspaceArchiveTarget[]> {
  const confirmed: WorkspaceArchiveTarget[] = [];

  for (const workspace of workspaces) {
    if (workspace.workspaceKind === "worktree") {
      const shouldArchive = await confirmWorktreeArchive({
        worktreeName: workspace.name,
        ...toWorktreeArchiveRisk(workspace),
      });
      if (!shouldArchive) {
        continue;
      }
    }

    confirmed.push({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
    });
  }

  return confirmed;
}

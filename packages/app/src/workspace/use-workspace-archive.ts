import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { confirmRiskyWorktreeArchive } from "@/git/worktree-archive-warning";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

// A workspace is the last reference to its backing worktree when no other active
// workspace on the same host points at the same directory. A directory can back
// multiple workspaces (Model B), so a sibling reference must keep the worktree on
// disk even when this workspace is archived. Local checkouts are never worktrees,
// so they never reach the disk-deletion prompt.
export function useIsLastWorktreeReference(workspace: SidebarWorkspaceEntry): boolean {
  return useSessionStore((state) => {
    if (workspace.workspaceKind !== "worktree") {
      return false;
    }
    const directory = normalizeWorkspacePath(workspace.workspaceDirectory);
    if (!directory) {
      return false;
    }
    const workspaces = state.sessions[workspace.serverId]?.workspaces;
    if (!workspaces) {
      return true;
    }
    for (const candidate of workspaces.values()) {
      if (candidate.id === workspace.workspaceId) {
        continue;
      }
      if (normalizeWorkspacePath(candidate.workspaceDirectory) === directory) {
        return false;
      }
    }
    return true;
  });
}

export interface WorkspaceArchiveController {
  // Begins the archive flow. For a last-reference worktree this opens the inline
  // keep/delete prompt; otherwise it archives the workspace record directly.
  beginArchive: () => void;
  // Inline prompt state for the last-reference worktree case.
  deletePromptOpen: boolean;
  confirmKeepOnDisk: () => void;
  confirmDeleteFromDisk: () => void;
  cancelDeletePrompt: () => void;
}

export function useWorkspaceArchive(input: {
  workspace: SidebarWorkspaceEntry;
  onArchiveStarted: () => void;
  onSetHiding?: (hiding: boolean) => void;
}): WorkspaceArchiveController {
  const { workspace, onArchiveStarted, onSetHiding } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const archiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);
  const isLastWorktreeReference = useIsLastWorktreeReference(workspace);
  const [deletePromptOpen, setDeletePromptOpen] = useState(false);

  const archiveWorktreeRecord = useCallback(
    (deleteWorktreeFromDisk: boolean) => {
      let archiveDirectory: string;
      try {
        archiveDirectory = requireWorkspaceDirectory({
          workspaceId: workspace.workspaceId,
          workspaceDirectory: workspace.workspaceDirectory,
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("sidebar.workspace.toasts.workspacePathUnavailable"),
        );
        return;
      }
      onArchiveStarted();
      void archiveWorktree({
        serverId: workspace.serverId,
        cwd: archiveDirectory,
        worktreePath: archiveDirectory,
        workspaceId: workspace.workspaceId,
        deleteWorktreeFromDisk,
      }).catch((error) => {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
        );
      });
    },
    [archiveWorktree, onArchiveStarted, t, toast, workspace],
  );

  const archiveNonWorktreeRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(workspace.serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    onSetHiding?.(true);
    try {
      await archiveWorkspaceOptimistically({
        client,
        workspace,
        afterHide: onArchiveStarted,
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hideFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onArchiveStarted, onSetHiding, t, toast, workspace]);

  const beginArchive = useCallback(() => {
    void (async () => {
      if (workspace.workspaceKind === "worktree") {
        const confirmed = await confirmRiskyWorktreeArchive({
          worktreeName: workspace.name,
          isDirty: workspace.archiveHasUncommittedChanges,
          aheadOfOrigin: workspace.archiveUnpushedCommitCount,
          diffStat: workspace.diffStat,
        });
        if (!confirmed) {
          return;
        }
        if (isLastWorktreeReference) {
          setDeletePromptOpen(true);
          return;
        }
        archiveWorktreeRecord(false);
        return;
      }
      await archiveNonWorktreeRecord();
    })();
  }, [archiveNonWorktreeRecord, archiveWorktreeRecord, isLastWorktreeReference, workspace]);

  const confirmKeepOnDisk = useCallback(() => {
    setDeletePromptOpen(false);
    archiveWorktreeRecord(false);
  }, [archiveWorktreeRecord]);

  const confirmDeleteFromDisk = useCallback(() => {
    setDeletePromptOpen(false);
    archiveWorktreeRecord(true);
  }, [archiveWorktreeRecord]);

  const cancelDeletePrompt = useCallback(() => {
    setDeletePromptOpen(false);
  }, []);

  return {
    beginArchive,
    deletePromptOpen,
    confirmKeepOnDisk,
    confirmDeleteFromDisk,
    cancelDeletePrompt,
  };
}

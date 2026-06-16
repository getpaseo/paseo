import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null | undefined;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  onArchiveStarted: () => void;
  onSetHiding?: (hiding: boolean) => void;
}

export interface WorkspaceArchiveController {
  archive: () => void;
}

export function useWorkspaceArchive(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const {
    serverId,
    workspaceId,
    workspaceDirectory,
    workspaceKind,
    name,
    isDirty,
    aheadOfOrigin,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const archiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);

  const archiveWorktreeRecord = useCallback(() => {
    let archiveDirectory: string;
    try {
      archiveDirectory = requireWorkspaceDirectory({
        workspaceId,
        workspaceDirectory,
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
      serverId,
      cwd: archiveDirectory,
      worktreePath: archiveDirectory,
      workspaceId,
    }).catch((error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
      );
    });
  }, [archiveWorktree, onArchiveStarted, serverId, t, toast, workspaceDirectory, workspaceId]);

  const archiveNonWorktreeRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    onSetHiding?.(true);
    try {
      await archiveWorkspaceOptimistically({
        client,
        workspace: {
          serverId,
          workspaceId,
        },
        afterHide: onArchiveStarted,
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hideFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onArchiveStarted, onSetHiding, serverId, t, toast, workspaceId]);

  const archive = useCallback(() => {
    void (async () => {
      if (workspaceKind === "worktree") {
        const confirmed = await confirmRiskyWorktreeArchive(
          {
            worktreeName: name,
            isDirty,
            aheadOfOrigin,
            diffStat,
          },
          warningLabels,
        );
        if (!confirmed) {
          return;
        }
        archiveWorktreeRecord();
        return;
      }
      await archiveNonWorktreeRecord();
    })();
  }, [
    aheadOfOrigin,
    archiveNonWorktreeRecord,
    archiveWorktreeRecord,
    diffStat,
    isDirty,
    name,
    warningLabels,
    workspaceKind,
  ]);

  return {
    archive,
  };
}

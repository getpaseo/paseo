import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useWorkspaceTabsStore } from "@/stores/workspace-tabs-store";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import { resolveWorkspaceArchiveConfirmationKind } from "@/workspace/workspace-archive-confirmation";

function purgeArchivedWorkspaceState(input: { serverId: string; workspaceId: string }): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
  useWorkspaceTabsStore.getState().purgeWorkspace(input);
}

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
  isChatWorkspace?: boolean;
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
    workspaceKind,
    name,
    isDirty,
    aheadOfOrigin,
    diffStat,
    isChatWorkspace = false,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();

  const archiveWorkspaceRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    onSetHiding?.(true);
    try {
      onArchiveStarted();
      await archiveWorkspaceOptimistically({
        client,
        workspace: {
          serverId,
          workspaceId,
        },
      });
      purgeArchivedWorkspaceState({ serverId, workspaceId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onArchiveStarted, onSetHiding, serverId, t, toast, workspaceId]);

  const archive = useCallback(() => {
    void (async () => {
      const confirmationKind = resolveWorkspaceArchiveConfirmationKind({
        isChatWorkspace,
        workspaceKind,
      });

      if (confirmationKind === "chat") {
        const confirmed = await confirmDialog({
          title: t("sidebar.workspace.archiveChat.title"),
          message: t("sidebar.workspace.archiveChat.message"),
          confirmLabel: t("sidebar.workspace.archiveChat.confirm"),
          cancelLabel: t("sidebar.workspace.archiveChat.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
      } else if (confirmationKind === "worktree") {
        const confirmed = await confirmRiskyWorktreeArchive(
          {
            workspaceName: name,
            isDirty,
            aheadOfOrigin,
            diffStat,
          },
          warningLabels,
        );
        if (!confirmed) {
          return;
        }
      }
      await archiveWorkspaceRecord();
    })();
  }, [
    aheadOfOrigin,
    archiveWorkspaceRecord,
    diffStat,
    isChatWorkspace,
    isDirty,
    name,
    t,
    warningLabels,
    workspaceKind,
  ]);

  return {
    archive,
  };
}

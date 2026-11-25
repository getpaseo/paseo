import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  readWorktreeArchiveDirectory,
  readWorktreeArchiveRisk,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { archiveWorkspaceWithUndo, supportsWorkspaceArchiveUndo } from "@/workspace/archive-undo";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  archiveWorkspaceOptimistically,
  runWorkspaceArchiveAttempt,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

function supportsWorkspaceArchiveInspect(serverId: string): boolean {
  return (
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.workspaceArchiveInspect ===
    true
  );
}

function purgeArchivedWorkspaceState(input: { serverId: string; workspaceId: string }): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  workspaceDirectory: string;
  name: string;
  /** Labels the warning's line counts. Whether to warn comes from the host's git state. */
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  /** Runs once the archive starts, with the workspace being archived. */
  onArchiveStarted: (workspace: WorkspaceArchiveTarget) => void;
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
    workspaceDirectory,
    name,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();
  // The archive starts after the host answers and you confirm. By then you may have opened another
  // workspace, so the redirect reads the selection from the latest render.
  const onArchiveStartedRef = useRef(onArchiveStarted);
  onArchiveStartedRef.current = onArchiveStarted;

  // Set when the host said the worktree stays, so the archive can't remove it after all.
  const expectDirectoryKeptRef = useRef(false);

  const archiveWorkspaceRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    const workspace = { serverId, workspaceId };
    onSetHiding?.(true);
    try {
      onArchiveStartedRef.current(workspace);
      if (supportsWorkspaceArchiveUndo(serverId)) {
        await archiveWorkspaceWithUndo({
          client,
          workspace,
          toast,
          options: { expectDirectoryKept: expectDirectoryKeptRef.current },
          onArchiveCommitted: () => purgeArchivedWorkspaceState(workspace),
        });
      } else {
        // COMPAT(workspaceArchiveUndo): hosts before v0.15.3 cannot undo; remove after 2027-05-06.
        await archiveWorkspaceOptimistically({ client, workspace });
        purgeArchivedWorkspaceState(workspace);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onSetHiding, serverId, t, toast, workspaceId]);

  // The host removes a worktree it archives, uncommitted work included. Ask it what that would
  // lose: the sidebar row's git status is empty until the row receives it.
  const confirmWorktreeArchive = useCallback(async (): Promise<boolean> => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return false;
    }
    const risk = await Promise.all([
      readWorktreeArchiveRisk(client, workspaceDirectory),
      // COMPAT(workspaceArchiveInspect): hosts before v0.17.5 don't say; remove after 2027-05-25.
      supportsWorkspaceArchiveInspect(serverId)
        ? readWorktreeArchiveDirectory(client, workspaceId)
        : null,
    ]).then(
      ([gitRisk, directory]) => ({ ...gitRisk, directory }),
      (error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
        );
        return null;
      },
    );
    if (!risk) {
      return false;
    }
    expectDirectoryKeptRef.current = risk.directory === "shared";
    return await confirmRiskyWorktreeArchive(
      { workspaceName: name, diffStat, ...risk },
      warningLabels,
    );
  }, [diffStat, name, serverId, t, toast, warningLabels, workspaceDirectory, workspaceId]);

  const archive = useCallback(() => {
    void runWorkspaceArchiveAttempt({
      workspace: { serverId, workspaceId },
      confirm: workspaceKind === "worktree" ? confirmWorktreeArchive : undefined,
      archive: archiveWorkspaceRecord,
    });
  }, [archiveWorkspaceRecord, confirmWorktreeArchive, serverId, workspaceId, workspaceKind]);

  return {
    archive,
  };
}

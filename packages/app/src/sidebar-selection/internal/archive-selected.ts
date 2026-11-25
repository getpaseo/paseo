import type { ToastApi } from "@/components/toast-host";
import type { CheckoutStatusClient } from "@/git/checkout-status-cache";
import {
  confirmRiskyBulkWorktreeArchive,
  readWorktreeArchiveRisk,
  type WorktreeArchiveConfirmationInput,
} from "@/git/worktree-archive-warning";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  archiveWorkspacesWithUndo,
  hasUndoableWorkspaceArchive,
  supportsWorkspaceArchiveUndo,
  type UndoableWorkspaceArchiveClient,
} from "@/workspace/archive-undo";
import {
  archiveWorkspaceOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

export interface BulkArchiveClient extends UndoableWorkspaceArchiveClient, CheckoutStatusClient {}

export interface BulkArchiveWorkspacesDeps {
  getClient: (serverId: string) => BulkArchiveClient | null;
  supportsUndo: (serverId: string) => boolean;
  readWorktreeRisk: typeof readWorktreeArchiveRisk;
  confirmRiskyBulkArchive: typeof confirmRiskyBulkWorktreeArchive;
  archiveWithUndo: typeof archiveWorkspacesWithUndo;
  archiveWithoutUndo: typeof archiveWorkspaceOptimistically;
  hasActiveUndo: () => boolean;
  purgeWorkspaceState: (workspace: WorkspaceArchiveTarget) => void;
  redirectActiveWorkspace: (workspace: WorkspaceArchiveTarget) => void;
}

function defaultPurgeWorkspaceState(workspace: WorkspaceArchiveTarget): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(workspace);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}

export function createDefaultBulkArchiveDeps(
  getActiveWorkspaceSelection: () => ActiveWorkspaceSelection | null,
): BulkArchiveWorkspacesDeps {
  return {
    getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
    supportsUndo: supportsWorkspaceArchiveUndo,
    readWorktreeRisk: readWorktreeArchiveRisk,
    confirmRiskyBulkArchive: confirmRiskyBulkWorktreeArchive,
    archiveWithUndo: archiveWorkspacesWithUndo,
    archiveWithoutUndo: archiveWorkspaceOptimistically,
    hasActiveUndo: hasUndoableWorkspaceArchive,
    purgeWorkspaceState: defaultPurgeWorkspaceState,
    redirectActiveWorkspace: (workspace) => {
      redirectIfArchivingActiveWorkspace({
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
        activeWorkspaceSelection: getActiveWorkspaceSelection(),
      });
    },
  };
}

function formatArchiveFailureMessage(failures: ReadonlyArray<{ error: unknown }>): string {
  if (failures.length > 1) {
    return i18n.t("sidebar.workspace.toasts.archiveMultipleFailed", { count: failures.length });
  }
  const error = failures[0]?.error;
  return error instanceof Error ? error.message : i18n.t("sidebar.workspace.toasts.archiveFailed");
}

interface ResolvedWorkspaceTarget {
  entry: SidebarWorkspaceEntry;
  client: BulkArchiveClient;
}

export async function archiveSelectedWorkspaces(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  toast: ToastApi;
  fallbackErrorToast?: ToastApi;
  onArchiveStarted: () => void;
  deps: BulkArchiveWorkspacesDeps;
}): Promise<boolean> {
  const { workspaces, toast, fallbackErrorToast, onArchiveStarted, deps } = input;
  if (workspaces.length === 0) return false;

  const resolved: ResolvedWorkspaceTarget[] = [];
  for (const entry of workspaces) {
    const client = deps.getClient(entry.serverId);
    if (!client) {
      toast.error(i18n.t("sidebar.workspace.toasts.hostDisconnected"));
      return false;
    }
    resolved.push({ entry, client });
  }

  const riskyWorkspaces: WorktreeArchiveConfirmationInput[] = [];
  const worktrees = resolved.filter((item) => item.entry.workspaceKind === "worktree");
  if (worktrees.length > 0) {
    try {
      const risks = await Promise.all(
        worktrees.map(async ({ entry, client }) => {
          const risk = await deps.readWorktreeRisk(client, entry.workspaceDirectory);
          return {
            workspaceName: entry.name,
            diffStat: entry.diffStat,
            isDirty: risk.isDirty,
            aheadOfOrigin: risk.aheadOfOrigin,
          } satisfies WorktreeArchiveConfirmationInput;
        }),
      );
      riskyWorkspaces.push(...risks);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : i18n.t("sidebar.workspace.toasts.archiveFailed"),
      );
      return false;
    }
  }

  if (riskyWorkspaces.length > 0) {
    const confirmed = await deps.confirmRiskyBulkArchive({
      totalCount: resolved.length,
      riskyWorkspaces,
    });
    if (!confirmed) {
      return false;
    }
  }

  // Redirect before optimistic removal hides the active workspace from the session store.
  for (const { entry } of resolved) {
    deps.redirectActiveWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId });
  }

  onArchiveStarted();

  const undoable: ResolvedWorkspaceTarget[] = [];
  const legacy: ResolvedWorkspaceTarget[] = [];
  for (const item of resolved) {
    if (deps.supportsUndo(item.entry.serverId)) {
      undoable.push(item);
    } else {
      legacy.push(item);
    }
  }

  const failures: Array<{ error: unknown }> = [];
  let showPartialFailure: (message: string) => boolean = () => false;

  await Promise.all([
    undoable.length > 0
      ? (async () => {
          const result = await deps.archiveWithUndo({
            entries: undoable.map(({ entry, client }) => {
              const workspace = { serverId: entry.serverId, workspaceId: entry.workspaceId };
              return {
                client,
                workspace,
                onArchiveCommitted: () => deps.purgeWorkspaceState(workspace),
              };
            }),
            toast,
          });
          failures.push(...result.failures);
          showPartialFailure = result.showPartialFailure;
        })()
      : Promise.resolve(),
    // COMPAT(workspaceArchiveUndo): hosts before v0.15.3 cannot undo; remove after 2027-05-06.
    ...legacy.map(async ({ entry, client }) => {
      const workspace = { serverId: entry.serverId, workspaceId: entry.workspaceId };
      try {
        await deps.archiveWithoutUndo({ client, workspace });
        deps.purgeWorkspaceState(workspace);
      } catch (error) {
        failures.push({ error });
      }
    }),
  ]);

  if (failures.length > 0) {
    const errorMessage = formatArchiveFailureMessage(failures);
    if (!showPartialFailure(errorMessage)) {
      // If a newer batch now owns the sidebar Undo toast, surface this older failure on the
      // app-level toast instead of displacing the active Undo window and purging its layouts.
      const errorToast = deps.hasActiveUndo() ? (fallbackErrorToast ?? toast) : toast;
      errorToast.error(errorMessage);
    }
  }

  return failures.length === 0;
}

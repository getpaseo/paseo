import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleCheck, Tag } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuItem, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useWorkspaceReadState } from "@/hooks/use-workspace-read-state";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceLabelMenuPages, WORKSPACE_LABEL_PAGE_ID } from "@/workspace-labels/picker";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCircle = withUnistyles(Circle);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedTag = withUnistyles(Tag);
const unreadIcon = <ThemedCircle size={16} uniProps={mutedColorMapping} />;
const readIcon = <ThemedCircleCheck size={16} uniProps={mutedColorMapping} />;
const labelsIcon = <ThemedTag size={16} uniProps={mutedColorMapping} />;

function WorkspaceReadStateMenuItem({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { hasClearableAttention, canMarkUnread, clearAttention, markUnread } =
    useWorkspaceReadState({ serverId, workspaceId });
  const handleSelect = useCallback(() => {
    const update = hasClearableAttention ? clearAttention : markUnread;
    void update().catch((error: unknown) => {
      const fallback = hasClearableAttention
        ? t("sidebar.workspace.toasts.markAsReadFailed")
        : t("sidebar.workspace.toasts.markAsUnreadFailed");
      toast.error(error instanceof Error ? error.message : fallback);
    });
  }, [clearAttention, hasClearableAttention, markUnread, t, toast]);
  if (!hasClearableAttention && !canMarkUnread) return null;
  return (
    <DropdownMenuItem
      leading={hasClearableAttention ? readIcon : unreadIcon}
      onSelect={handleSelect}
    >
      {t(
        hasClearableAttention
          ? "sidebar.workspace.actions.markAsRead"
          : "sidebar.workspace.actions.markAsUnread",
      )}
    </DropdownMenuItem>
  );
}

export function useWorkspaceHeaderManagement({
  serverId,
  workspace,
  isRouteFocused,
}: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
  isRouteFocused: boolean;
}) {
  const { t } = useTranslation();
  const workspaceId = workspace?.id ?? "";
  const assignedLabels = workspace?.labels;
  const labelTarget = useMemo(
    () => (workspaceId ? { serverId, workspaceId, labels: assignedLabels ?? [] } : null),
    [assignedLabels, serverId, workspaceId],
  );
  const pages = useWorkspaceLabelMenuPages(labelTarget);

  const [isHiding, setIsHiding] = useState(false);
  const isArchiving = workspace?.archivingAt != null || isHiding;
  // Worktree confirmation can finish after the workspace screen has lost focus or unmounted.
  const focusedRef = useRef(false);
  useLayoutEffect(() => {
    focusedRef.current = isRouteFocused;
    return () => {
      focusedRef.current = false;
    };
  }, [isRouteFocused]);
  const { archive } = useWorkspaceArchive({
    serverId,
    workspaceId,
    workspaceKind: workspace?.workspaceKind ?? "directory",
    workspaceDirectory: workspace?.workspaceDirectory ?? "",
    name: workspace?.title ?? workspace?.name ?? "",
    diffStat: workspace?.diffStat,
    onArchiveStarted: (target) => {
      if (focusedRef.current) {
        redirectIfArchivingActiveWorkspace({ ...target, activeWorkspaceSelection: target });
      }
    },
    onSetHiding: setIsHiding,
  });

  return useMemo(
    () => ({
      pages,
      items: workspaceId ? (
        <>
          <DropdownMenuSubTrigger id={WORKSPACE_LABEL_PAGE_ID} leading={labelsIcon}>
            {t("workspaceLabels.title")}
          </DropdownMenuSubTrigger>
          <WorkspaceReadStateMenuItem serverId={serverId} workspaceId={workspaceId} />
          <DropdownMenuItem
            leading={GIT_ACTION_ICONS.archive}
            disabled={isArchiving}
            status={isArchiving ? "pending" : "idle"}
            pendingLabel={t("workspace.git.actions.archive.pending")}
            onSelect={archive}
          >
            {t("workspace.git.actions.archive.label")}
          </DropdownMenuItem>
        </>
      ) : null,
    }),
    [archive, isArchiving, pages, serverId, t, workspaceId],
  );
}

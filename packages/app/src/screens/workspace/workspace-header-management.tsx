import { useCallback, useMemo } from "react";
import { Circle, CircleCheck, Tag } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuItem, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useActiveWorkspaceArchive } from "@/hooks/use-active-workspace-archive";
import { useWorkspaceReadState } from "@/hooks/use-workspace-read-state";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { useWorkspaceLabelMenuPages, WORKSPACE_LABEL_PAGE_ID } from "@/workspace-labels/picker";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";

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

function WorkspaceArchiveMenuItem() {
  const { t } = useTranslation();
  const { canArchive, archive } = useActiveWorkspaceArchive();
  return (
    <DropdownMenuItem
      testID="workspace-header-archive-workspace"
      leading={GIT_ACTION_ICONS.archive}
      disabled={!canArchive}
      onSelect={archive}
    >
      {t("sidebar.workspace.actions.archiveWorkspace")}
    </DropdownMenuItem>
  );
}

export function useWorkspaceHeaderManagement({
  serverId,
  workspace,
}: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
}) {
  const { t } = useTranslation();
  const workspaceId = workspace?.id ?? "";
  const workspaceDirectory = workspace?.workspaceDirectory ?? "";
  const assignedLabels = workspace?.labels;
  const labelTarget = useMemo(
    () => (workspaceId ? { serverId, workspaceId, labels: assignedLabels ?? [] } : null),
    [assignedLabels, serverId, workspaceId],
  );
  const pages = useWorkspaceLabelMenuPages(labelTarget);

  return useMemo(
    () => ({
      pages,
      items: workspaceId ? (
        <>
          <DropdownMenuSubTrigger id={WORKSPACE_LABEL_PAGE_ID} leading={labelsIcon}>
            {t("workspaceLabels.title")}
          </DropdownMenuSubTrigger>
          <WorkspaceReadStateMenuItem serverId={serverId} workspaceId={workspaceId} />
          <OpenInFileManagerMenuItem
            path={workspaceDirectory}
            testID="workspace-header-open-folder"
          />
          <WorkspaceArchiveMenuItem />
        </>
      ) : null,
    }),
    [pages, serverId, t, workspaceDirectory, workspaceId],
  );
}

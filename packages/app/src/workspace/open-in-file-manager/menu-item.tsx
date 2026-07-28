import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import type { Theme } from "@/styles/theme";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

interface OpenInFileManagerMenuItemProps {
  path?: string | null;
  testID: string;
  serverId?: string | null;
}

const ThemedFolderOpen = withUnistyles(FolderOpen);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const leadingIcon = <ThemedFolderOpen size={14} uniProps={foregroundMutedColorMapping} />;

export function OpenInFileManagerMenuItem({
  path,
  testID,
  serverId,
}: OpenInFileManagerMenuItemProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isElectron = getIsElectron();
  const workspacePath = path?.trim() ?? "";
  const isLocalDaemon = useIsLocalDaemon(serverId?.trim() ?? "");
  const hasServerId = serverId != null && serverId.trim().length > 0;
  const { targets } = useDesktopOpenTargets({
    isLocalExecution: isElectron && workspacePath.length > 0 && (!hasServerId || isLocalDaemon),
  });
  const fileManagerTarget = targets.find((target) => target.kind === "file-manager");

  const openInFileManager = useCallback(() => {
    if (!fileManagerTarget || workspacePath.length === 0) return;
    void openDesktopTarget({
      editorId: fileManagerTarget.id,
      workspacePath,
    }).catch((error) => {
      console.warn("[open-in-file-manager] open failed", error);
      toast.error(t("sidebar.project.actions.openFolderFailed"));
    });
  }, [fileManagerTarget, t, toast, workspacePath]);

  if (!isElectron || !fileManagerTarget || workspacePath.length === 0) {
    return null;
  }

  return (
    <DropdownMenuItem testID={testID} leading={leadingIcon} onSelect={openInFileManager}>
      {t("sidebar.project.actions.openFolder")}
    </DropdownMenuItem>
  );
}

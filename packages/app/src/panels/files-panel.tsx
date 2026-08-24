import { Text, View } from "react-native";
import { FolderTree } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { TreeRail } from "@/components/tree-rail";
import { useIsCompactFormFactor } from "@/constants/layout";

const ThemedFolderTree = withUnistyles(FolderTree);
const FILE_TREE_WIDTH = 220;

function useFilesPanelDescriptor() {
  const { t } = useTranslation();
  return {
    label: t("panels.files.label"),
    subtitle: t("panels.files.subtitle"),
    tooltip: t("panels.files.tooltip"),
    titleState: "ready" as const,
    icon: ThemedFolderTree,
    statusBucket: null,
  };
}

function FilesPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, retargetCurrentTab } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const isCompact = useIsCompactFormFactor();
  invariant(target.kind === "files", "FilesPanel requires files target");
  const onOpenFile = useCallback(
    (path: string) => retargetCurrentTab({ kind: "file", path }),
    [retargetCurrentTab],
  );
  if (!workspaceRoot) {
    return (
      <View style={styles.centerState}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  if (isCompact) {
    return (
      <FileExplorerPane
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceRoot={workspaceRoot}
        onOpenFile={onOpenFile}
        onAddToChat={canAddToChat ? addFile : undefined}
      />
    );
  }
  return (
    <TreeRail testID="files-tree-rail" width={FILE_TREE_WIDTH}>
      <View style={styles.centerState}>
        <Text style={styles.emptyText}>{t("panels.files.chooseFile")}</Text>
      </View>
      <FileExplorerPane
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceRoot={workspaceRoot}
        onOpenFile={onOpenFile}
        onAddToChat={canAddToChat ? addFile : undefined}
      />
    </TreeRail>
  );
}

export const filesPanelRegistration: PanelRegistration<"files"> = {
  kind: "files",
  resourceKey: () => "files",
  component: FilesPanel,
  useDescriptor: useFilesPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

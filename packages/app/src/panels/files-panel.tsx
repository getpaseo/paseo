import { Text, View } from "react-native";
import { FolderTree } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedFolderTree = withUnistyles(FolderTree);
const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

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
  invariant(target.kind === "files", "FilesPanel requires files target");
  const onOpenFile = useCallback(
    (path: string) => retargetCurrentTab({ kind: "file", path }),
    [retargetCurrentTab],
  );
  if (!workspaceRoot) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
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

export const filesPanelRegistration: PanelRegistration<"files"> = {
  kind: "files",
  resourceKey: () => "files",
  component: FilesPanel,
  useDescriptor: useFilesPanelDescriptor,
};

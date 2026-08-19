import { Text, View } from "react-native";
import { useCallback, useMemo } from "react";
import invariant from "tiny-invariant";
import { useTranslation } from "react-i18next";
import { FilePane } from "@/file-pane/pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { createMaterialFileIcon } from "@/components/material-file-icon";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { TreeRail } from "@/components/tree-rail";
import { useIsCompactFormFactor } from "@/constants/layout";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function useFilePanelDescriptor(target: { kind: "file"; path: string }) {
  const fileName = target.path.split("/").findLast(Boolean) ?? target.path;
  const icon = useMemo(() => createMaterialFileIcon(fileName), [fileName]);
  return {
    label: fileName,
    subtitle: target.path,
    tooltip: target.path,
    titleState: "ready" as const,
    icon,
    statusBucket: null,
  };
}

function FilePanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, fileNavigationRevision, retargetCurrentTab } =
    usePaneContext();
  const isCompact = useIsCompactFormFactor();
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const handleOpenFile = useCallback(
    (path: string) => retargetCurrentTab({ kind: "file", path }),
    [retargetCurrentTab],
  );
  invariant(target.kind === "file", "FilePanel requires file target");
  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  if (isCompact) {
    return (
      <FilePane
        serverId={serverId}
        workspaceRoot={workspaceDirectory}
        location={target}
        navigationRevision={fileNavigationRevision ?? 0}
      />
    );
  }
  return (
    <TreeRail testID="file-tree-rail">
      <FilePane
        serverId={serverId}
        workspaceRoot={workspaceDirectory}
        location={target}
        navigationRevision={fileNavigationRevision ?? 0}
      />
      <FileExplorerPane
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceRoot={workspaceDirectory}
        onOpenFile={handleOpenFile}
      />
    </TreeRail>
  );
}

export const filePanelRegistration: PanelRegistration<"file"> = {
  kind: "file",
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
};

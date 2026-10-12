import { useCallback } from "react";
import { Package } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { WorkspaceArtifacts } from "@/file-access/workspace-artifacts";

const ThemedPackage = withUnistyles(Package);
function ArtifactsPanel() {
  const { serverId, workspaceId, openPreferredTarget } = usePaneContext();
  const openFile = useCallback(
    (path: string) => openPreferredTarget({ kind: "file", path }, "chatFiles"),
    [openPreferredTarget],
  );
  return <WorkspaceArtifacts serverId={serverId} workspaceId={workspaceId} onOpen={openFile} />;
}
export const artifactsPanelRegistration = definePanel("artifacts", {
  component: ArtifactsPanel,
  presentation: {
    label: (t) => t("fileAccess.artifactsTab"),
    subtitle: (t) => t("fileAccess.artifacts"),
    tooltip: (t) => t("fileAccess.artifactsHint"),
    icon: ThemedPackage,
  },
});

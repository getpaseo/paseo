import { Text, View } from "react-native";
import { FileText } from "lucide-react-native";
import invariant from "tiny-invariant";
import { FilePane } from "@/components/file-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceExecutionAuthority } from "@/stores/session-store-hooks";

function useFilePanelDescriptor(target: { kind: "file"; path: string }) {
  const fileName = target.path.split("/").filter(Boolean).pop() ?? target.path;
  return {
    label: fileName,
    subtitle: target.path,
    titleState: "ready" as const,
    icon: FileText,
    statusBucket: null,
  };
}

function FilePanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const workspaceAuthority = useWorkspaceExecutionAuthority(serverId, workspaceId);
  const workspaceDirectory = workspaceAuthority?.ok
    ? workspaceAuthority.authority.workspaceDirectory
    : null;
  invariant(target.kind === "file", "FilePanel requires file target");
  if (!workspaceDirectory) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text>Workspace execution directory not found.</Text>
      </View>
    );
  }
  return <FilePane serverId={serverId} workspaceRoot={workspaceDirectory} filePath={target.path} />;
}

export const filePanelRegistration: PanelRegistration<"file"> = {
  kind: "file",
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
};

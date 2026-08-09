import { Code2 } from "lucide-react-native";
import { Text, View } from "react-native";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/desktop/browser/pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useCodeServerStore } from "@/stores/code-server-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function useCodeServerPanelDescriptor(target: {
  kind: "codeServer";
  codeServerId: string;
}): PanelDescriptor {
  const codeServer = useCodeServerStore(
    (state) => state.codeServersById[target.codeServerId] ?? null,
  );

  const label = codeServer?.title ?? "Code Server";
  return {
    label,
    subtitle: "Code Server",
    tooltip: label,
    titleState: "ready",
    icon: Code2,
    statusBucket: null,
  };
}

function CodeServerPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive } = usePaneFocus();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "codeServer", "CodeServerPanel requires codeServer target");
  const codeServer = useCodeServerStore(
    (state) => state.codeServersById[target.codeServerId] ?? null,
  );

  if (!codeServer) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>Code Server tab not found.</Text>
      </View>
    );
  }

  return (
    <BrowserPane
      browserId={codeServer.browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd}
      isInteractive={isInteractive}
      onFocusPane={focusPane}
      chrome="hidden"
    />
  );
}

export const codeServerPanelRegistration: PanelRegistration<"codeServer"> = {
  kind: "codeServer",
  component: CodeServerPanel,
  useDescriptor: useCodeServerPanelDescriptor,
};

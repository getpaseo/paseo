import { Globe } from "lucide-react-native";
import { View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/components/browser-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";

function useBrowserPanelDescriptor(
  target: { kind: "browser"; browserId: string },
  _context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  return {
    label: "Browser",
    subtitle: "Browser",
    titleState: "ready",
    icon: Globe,
    statusBucket: null,
  };
}

function BrowserPanel() {
  const isFocused = useIsFocused();
  const { serverId, workspaceId, target, isPaneFocused } = usePaneContext();
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  console.log("[BrowserPanel] target:", JSON.stringify(target));

  if (!isFocused) {
    return <View style={{ flex: 1 }} />;
  }

  return (
    <BrowserPane
      serverId={serverId}
      cwd={workspaceId}
      browserId={target.browserId}
      isPaneFocused={isPaneFocused}
      initialUrl={target.url}
    />
  );
}

export const browserPanelRegistration: PanelRegistration<"browser"> = {
  kind: "browser",
  component: BrowserPanel,
  useDescriptor: useBrowserPanelDescriptor,
};

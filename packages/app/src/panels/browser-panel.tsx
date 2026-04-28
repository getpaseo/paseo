"use no memo";
import { Globe } from "lucide-react-native";
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
  "use no memo";
  const { serverId, workspaceId, target, isPaneFocused } = usePaneContext();
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  console.log("[BrowserPanel] target:", JSON.stringify(target));

  // Keyed on browserId so React fully unmounts + remounts BrowserPane
  // when the id changes. Without this React would try to re-render
  // the same instance with new props, which was triggering
  // "Uncaught TypeError: Oc is not a function" during reconciliation —
  // the hook order of BrowserPane is tied to its browserId lifecycle
  // (ResizeObserver, IPC subscription, etc.) and React's in-place
  // update path gets confused when those get rebound mid-flight.
  return (
    <BrowserPane
      key={target.browserId}
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

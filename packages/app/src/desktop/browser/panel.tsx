import { useMemo } from "react";
import { Image } from "react-native";
import { Globe } from "lucide-react-native";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/desktop/browser/pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor, type PanelIconProps } from "@/panels/panel-registry";
import { useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

function getBrowserLabel(input: { title: string; url: string }): string {
  const title = input.title.trim();
  if (title) {
    return title;
  }

  try {
    const parsed = new URL(input.url);
    return parsed.hostname || input.url;
  } catch {
    return input.url;
  }
}

function createBrowserTabIcon(faviconUrl: string | null) {
  return function BrowserTabIcon({ size, color }: PanelIconProps) {
    const source = useMemo(() => (faviconUrl ? { uri: faviconUrl } : undefined), []);
    const imageStyle = useMemo(() => ({ width: size, height: size, borderRadius: 3 }), [size]);

    if (faviconUrl) {
      return <Image accessibilityIgnoresInvertColors source={source} style={imageStyle} />;
    }

    return <Globe size={size} color={color} />;
  };
}

function useBrowserPanelDescriptor(target: {
  kind: "browser";
  browserId: string;
}): PanelDescriptor {
  const browser = useBrowserStore((state) => state.browsersById[target.browserId] ?? null);
  const url = browser?.url ?? "about:blank";
  const icon = createBrowserTabIcon(browser?.faviconUrl ?? null);
  const label = getBrowserLabel({ title: browser?.title ?? "", url });

  return {
    label,
    subtitle: url,
    tooltip: url || label,
    titleState: "ready",
    icon,
    statusBucket: browser?.isLoading ? "running" : null,
  };
}

function BrowserPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive } = usePaneFocus();
  const workspace = useWorkspaceFields(serverId, workspaceId, (w) => ({
    cwd: w.workspaceDirectory,
    projectId: w.projectId,
    name: w.title || w.name,
  }));
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  return (
    <BrowserPane
      browserId={target.browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={workspace?.cwd ?? null}
      projectId={workspace?.projectId ?? null}
      workspaceName={workspace?.name ?? workspaceId}
      isInteractive={isInteractive}
      onFocusPane={focusPane}
    />
  );
}

export const browserPanelRegistration = definePanel("browser", {
  component: BrowserPanel,
  useDescriptor: useBrowserPanelDescriptor,
});

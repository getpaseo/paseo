import { useMemo } from "react";
import { Image } from "react-native";
import { Globe } from "lucide-react-native";
import invariant from "tiny-invariant";
import { getIsElectron } from "@/constants/platform";
import { RemoteBrowserPane } from "@/desktop/browser/remote-pane";
import { BrowserPane } from "@/desktop/browser/pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import {
  definePanel,
  type PanelDescriptor,
  type PanelDescriptorContext,
  type PanelIconProps,
} from "@/panels/panel-registry";
import {
  browserActivityStatusBucket,
  useActiveBrowserHandoff,
  useBrowserActivity,
} from "@/desktop/browser/activity";
import { useBrowserStore } from "@/desktop/browser/store";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

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

function useBrowserPanelDescriptor(
  target: {
    kind: "browser";
    browserId: string;
  },
  context: PanelDescriptorContext,
): PanelDescriptor {
  const browser = useBrowserStore((state) => state.browsersById[target.browserId] ?? null);
  const activity = useBrowserActivity(
    context.serverId,
    context.workspaceId,
    browser?.remoteBrowserId,
  );
  const handoff = useActiveBrowserHandoff(
    context.serverId,
    context.workspaceId,
    browser?.remoteBrowserId,
  );
  const loadingBucket = browser?.isLoading ? "running" : null;
  const runBucket = browserActivityStatusBucket(activity) ?? loadingBucket;
  const url = browser?.url ?? "https://example.com";
  const icon = createBrowserTabIcon(browser?.faviconUrl ?? null);
  const label = getBrowserLabel({ title: browser?.title ?? "", url });

  return {
    label,
    subtitle: url,
    tooltip: url || label,
    titleState: "ready",
    icon,
    statusBucket: handoff ? "needs_input" : runBucket,
  };
}

function BrowserPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive } = usePaneFocus();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const supportsRemoteBrowser = useHostFeature(serverId, "remoteBrowser");
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  if (!supportsRemoteBrowser && getIsElectron()) {
    return (
      <BrowserPane
        browserId={target.browserId}
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={cwd}
        isInteractive={isInteractive}
        onFocusPane={focusPane}
      />
    );
  }
  return (
    <RemoteBrowserPane
      browserId={target.browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      isInteractive={isInteractive}
      onFocusPane={focusPane}
    />
  );
}

export const browserPanelRegistration = definePanel("browser", {
  component: BrowserPanel,
  useDescriptor: useBrowserPanelDescriptor,
});

import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { isAgentBrowserTab } from "@/workspace-tabs/agent-browser";
import { useTranslation } from "react-i18next";
import { useCallback, useMemo } from "react";
import { Image } from "react-native";
import { Globe } from "lucide-react-native";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/desktop/browser/pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor, type PanelIconProps } from "@/panels/panel-registry";
import { useBrowserStore } from "@/desktop/browser/store";
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

function useBrowserPanelDescriptor(target: {
  kind: "browser";
  browserId: string;
}): PanelDescriptor {
  const { t } = useTranslation();
  const browser = useBrowserStore((state) => state.browsersById[target.browserId] ?? null);
  const agentBrowser = useWorkspaceLayoutStore((store) =>
    Object.values(store.layoutByWorkspace).some((layout) =>
      collectAllTabs(layout.root).some(
        (tab) =>
          tab.target.kind === "browser" &&
          tab.target.browserId === target.browserId &&
          isAgentBrowserTab(tab),
      ),
    ),
  );
  const url = browser?.url ?? "https://example.com";
  const icon = createBrowserTabIcon(browser?.faviconUrl ?? null);
  let label =
    url === "about:blank"
      ? t("workspace.browser.newTab")
      : getBrowserLabel({ title: browser?.title ?? "", url });
  if (agentBrowser) label = t("workspace.browser.agentBrowser.label");

  return {
    label,
    subtitle: url,
    tooltip: url === "about:blank" ? label : url || label,
    titleState: "ready",
    icon,
    statusBucket: browser?.isLoading ? "running" : null,
  };
}

function BrowserPanel() {
  const { serverId, workspaceId, target, state, setCurrentTabState } = usePaneContext();
  const tabState = useMemo(
    () => (state && typeof state === "object" && !Array.isArray(state) ? state : {}),
    [state],
  );
  const focusAddressOnOpen = tabState.browserAddressFocusPending === true;
  const onAddressFocusHandled = useCallback(() => {
    const { browserAddressFocusPending: _pending, ...rest } = tabState;
    setCurrentTabState(rest);
  }, [tabState, setCurrentTabState]);
  const { focusPane, isInteractive } = usePaneFocus();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  return (
    <BrowserPane
      browserId={target.browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd}
      isInteractive={isInteractive}
      onFocusPane={focusPane}
      focusAddressOnOpen={focusAddressOnOpen}
      onAddressFocusHandled={onAddressFocusHandled}
    />
  );
}

export const browserPanelRegistration = definePanel("browser", {
  component: BrowserPanel,
  useDescriptor: useBrowserPanelDescriptor,
});

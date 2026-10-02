import { useTranslation } from "react-i18next";
import { useCallback, useMemo, useState } from "react";
import { Image, View } from "react-native";
import { Globe } from "@/components/icons/ui-icons";
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
  useBrowserActivityStore,
} from "@/desktop/browser/activity";
import { BrowserActivityBar, BrowserHandoffBar } from "@/desktop/browser/activity-bar";
import type { BrowserHandoffAction } from "@/desktop/browser/activity-bar";
import { useBrowserStore } from "@/desktop/browser/store";
import { getBrowserPaneKind } from "@/desktop/browser/remote-tab-records";
import { DEFAULT_BROWSER_URL } from "@/desktop/browser/store/state";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

function isBlankPage(url: string, title: string): boolean {
  const blank = (value: string) => value === "" || value === "about:blank";
  return blank(url.trim()) && blank(title.trim());
}

function getBrowserLabel(input: { title: string; url: string; blankLabel: string }): string {
  if (isBlankPage(input.url, input.title)) {
    return input.blankLabel;
  }
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
  const url = browser?.url ?? DEFAULT_BROWSER_URL;
  const icon = createBrowserTabIcon(browser?.faviconUrl ?? null);
  const { t } = useTranslation();
  const label = getBrowserLabel({
    title: browser?.title ?? "",
    url,
    blankLabel: t("workspace.tabs.fallback.blankBrowser"),
  });

  return {
    label,
    subtitle: url,
    tooltip: url || label,
    titleState: "ready",
    icon,
    statusBucket: handoff ? "needs_input" : runBucket,
  };
}

const browserPanelStyle = { flex: 1 };

function BrowserPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive } = usePaneFocus();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  const remoteBrowserId = useBrowserStore(
    (state) => state.browsersById[target.browserId]?.remoteBrowserId ?? null,
  );

  const handoff = useActiveBrowserHandoff(serverId, workspaceId, remoteBrowserId ?? undefined);
  const activity = useBrowserActivity(serverId, workspaceId, remoteBrowserId ?? undefined);
  const client = useHostRuntimeClient(serverId);
  const [handoffAction, setHandoffAction] = useState<BrowserHandoffAction | null>(null);
  const control = useCallback(
    (action: "pause" | "resume" | BrowserHandoffAction) => {
      if (!client || !remoteBrowserId) return;
      if (action === "finish_handoff" || action === "cancel_handoff") setHandoffAction(action);
      void client
        .controlBrowserActivity({ workspaceId, browserId: remoteBrowserId, action })
        .catch((error) => {
          useBrowserStore.getState().updateBrowser(target.browserId, {
            lastError: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        })
        .finally(() => setHandoffAction(null));
    },
    [client, remoteBrowserId, target.browserId, workspaceId],
  );
  const dismiss = useCallback(() => {
    if (activity) useBrowserActivityStore.getState().dismiss(serverId, activity);
  }, [activity, serverId]);
  const supportsHostBrowser = useHostFeature(serverId, "browserScreencast");
  const paneKind = getBrowserPaneKind({
    isElectron: getIsElectron(),
    supportsHostBrowser,
    remoteBrowserId,
  });
  if (paneKind === "desktop") {
    return (
      <View style={browserPanelStyle}>
        {handoff ? (
          <BrowserHandoffBar handoff={handoff} pendingAction={handoffAction} onEnd={control} />
        ) : null}
        {activity ? (
          <BrowserActivityBar activity={activity} onControl={control} onDismiss={dismiss} />
        ) : null}
        <BrowserPane
          browserId={target.browserId}
          serverId={serverId}
          workspaceId={workspaceId}
          cwd={cwd}
          isInteractive={isInteractive}
          onFocusPane={focusPane}
        />
      </View>
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

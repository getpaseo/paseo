import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserMirrorAction } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { Image, View } from "react-native";
import { Globe } from "@/components/icons/ui-icons";
import invariant from "tiny-invariant";
import { getIsElectron, isNative } from "@/constants/platform";
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
import {
  MIRROR_ORIGIN,
  mirrorReplayReadySource,
  subscribeBrowserMirrorReplay,
  subscribeLocalMirrorCapture,
} from "@/desktop/browser/mirror";
import { whileCreatingRemoteTab } from "@/desktop/browser/remote-tab-sync";
import { DEFAULT_BROWSER_URL } from "@/desktop/browser/store/state";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getDesktopHost } from "@/desktop/host";
import { resolveBrowserUrl } from "@/desktop/browser/tunnel";
import { waitForBrowserRegistration } from "@/desktop/browser/automation/handler";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

// A tab that never loaded a page shows Chrome's "about:blank", which reads as an error.
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

let mirrorRequestSequence = 0;
const desktopReplayCursors = new Map<string, { at: number }>();
const browserPanelStyle = { flex: 1 };
// A navigation this soon after a mirrored step is that step's consequence, not a new one.
const FOLLOW_UP_NAVIGATION_MS = 2_500;

interface BrowserMirrorInput {
  serverId: string;
  workspaceId: string;
  remoteBrowserId: string | null;
  localBrowserId: string;
  enabled: boolean;
}

/**
 * Keeps this app's own browser in step with the workspace's daemon tab in both directions:
 * the daemon's steps (an agent's, or another app's) are replayed here, and the person's
 * clicks and typing here go to the daemon, which passes them on. Only DOM-level steps
 * travel; nothing is streamed.
 */
function useBrowserMirror(input: BrowserMirrorInput) {
  const { serverId, workspaceId, remoteBrowserId, localBrowserId, enabled } = input;
  const client = useHostRuntimeClient(serverId);
  const supportsMirror = useHostFeature(serverId, "browserMirror");
  const lastMirroredStepAtRef = useRef(0);

  // A tab opened in this app becomes a workspace tab, so every other device sees it too.
  useEffect(() => {
    if (!enabled || !supportsMirror || remoteBrowserId || !client) return;
    const url = useBrowserStore.getState().browsersById[localBrowserId]?.url ?? DEFAULT_BROWSER_URL;
    void whileCreatingRemoteTab(async () => {
      const created = await client.executeRemoteBrowserCommand({
        workspaceId,
        command: { command: "new_tab", args: { url } },
      });
      if (created.ok && created.result.command === "new_tab") {
        useBrowserStore
          .getState()
          .updateBrowser(localBrowserId, { remoteBrowserId: created.result.browserId });
      }
    }).catch(() => undefined);
  }, [client, enabled, localBrowserId, remoteBrowserId, supportsMirror, workspaceId]);

  useEffect(() => {
    const execute = getDesktopHost()?.browser?.executeAutomationCommand;
    if (!enabled || !remoteBrowserId || !execute) return;
    const request = (command: BrowserAutomationCommand) =>
      ({
        type: "browser.automation.execute.request",
        requestId: `mirror-${(mirrorRequestSequence += 1)}`,
        workspaceId,
        command,
      }) as const;
    const registered = waitForBrowserRegistration({
      request: request({ command: "list_tabs", args: {} }),
      browserId: localBrowserId,
      workspaceId,
      executeAutomationCommand: execute,
    });
    const run = async (command: BrowserAutomationCommand) => {
      if (!(await registered)) throw new Error("Local browser did not become ready");
      const result = await execute(request(command));
      if (!result.ok) throw new Error(result.error.message);
    };
    const replay = async (action: BrowserMirrorAction): Promise<void> => {
      lastMirroredStepAtRef.current = Date.now();
      if (action.kind !== "navigate") {
        await run({
          command: "evaluate",
          args: { browserId: localBrowserId, function: mirrorReplayReadySource(action) },
        });
        return;
      }
      if (!client) throw new Error("Host connection unavailable");
      const url = await resolveBrowserUrl({
        client,
        serverId,
        workspaceId,
        browserId: remoteBrowserId,
        url: action.url,
      });
      // The record may already contain the daemon URL while the guest is still blank.
      const actual = await execute(request({ command: "list_tabs", args: {} }));
      const current =
        actual.ok && actual.result.command === "list_tabs"
          ? actual.result.tabs.find((tab) => tab.browserId === localBrowserId)?.url
          : undefined;
      if (current !== url)
        await run({ command: "navigate", args: { browserId: localBrowserId, url } });
    };
    const key = `${serverId}\u0000${localBrowserId}`;
    const cursor = desktopReplayCursors.get(key) ?? { at: 0 };
    desktopReplayCursors.set(key, cursor);
    return subscribeBrowserMirrorReplay({
      serverId,
      browserId: remoteBrowserId,
      cursor,
      replay,
      onError: (error) =>
        useBrowserStore.getState().updateBrowser(localBrowserId, {
          lastError: error instanceof Error ? error.message : String(error),
        }),
    });
  }, [client, enabled, localBrowserId, remoteBrowserId, serverId, workspaceId]);

  useEffect(() => {
    if (!enabled || !remoteBrowserId || !client) return;
    const send = (action: BrowserMirrorAction) =>
      client.applyBrowserMirrorAction({
        workspaceId,
        browserId: remoteBrowserId,
        action,
        origin: MIRROR_ORIGIN,
      });
    const stopCapture = subscribeLocalMirrorCapture(localBrowserId, (action) => {
      lastMirroredStepAtRef.current = Date.now();
      send(action);
    });
    // The address bar, back and forward move the page without a click the page can see.
    const stopAddress = useBrowserStore.subscribe((state, previous) => {
      if (!getIsElectron()) return;
      const url = state.browsersById[localBrowserId]?.url;
      if (!url || url === previous.browsersById[localBrowserId]?.url) return;
      if (Date.now() - lastMirroredStepAtRef.current < FOLLOW_UP_NAVIGATION_MS) return;
      if (/^https?:/i.test(url)) send({ kind: "navigate", url });
    });
    return () => {
      stopCapture();
      stopAddress();
    };
  }, [client, enabled, localBrowserId, remoteBrowserId, workspaceId]);
}

function BrowserPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const { focusPane, isInteractive } = usePaneFocus();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  const remoteBrowserId = useBrowserStore(
    (state) => state.browsersById[target.browserId]?.remoteBrowserId ?? null,
  );
  // A handed-off tab needs the daemon's own page: the login has to land there.
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
  const mirrorsLocally = getIsElectron() || isNative;
  useBrowserMirror({
    serverId,
    workspaceId,
    remoteBrowserId,
    localBrowserId: target.browserId,
    enabled: mirrorsLocally,
  });
  if (mirrorsLocally) {
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

import { useEffect, useMemo, useRef } from "react";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserMirrorAction } from "@getpaseo/protocol/browser-activity/rpc-schemas";
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
import {
  MIRROR_ORIGIN,
  mirrorReplaySource,
  subscribeBrowserMirror,
  subscribeLocalMirrorCapture,
} from "@/desktop/browser/mirror";
import { whileCreatingRemoteTab } from "@/desktop/browser/remote-tab-sync";
import { DEFAULT_BROWSER_URL } from "@/desktop/browser/store/state";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getDesktopHost } from "@/desktop/host";
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
  const url = browser?.url ?? DEFAULT_BROWSER_URL;
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

let mirrorRequestSequence = 0;
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
    const run = (command: BrowserAutomationCommand) =>
      execute({
        type: "browser.automation.execute.request",
        requestId: `mirror-${(mirrorRequestSequence += 1)}`,
        workspaceId,
        command,
      });
    const replay = async (action: BrowserMirrorAction): Promise<void> => {
      lastMirroredStepAtRef.current = Date.now();
      if (action.kind !== "navigate") {
        await run({
          command: "evaluate",
          args: { browserId: localBrowserId, function: mirrorReplaySource(action) },
        });
        return;
      }
      const current = useBrowserStore.getState().browsersById[localBrowserId]?.url;
      if (current !== action.url) {
        await run({ command: "navigate", args: { browserId: localBrowserId, url: action.url } });
      }
    };
    let queue = Promise.resolve();
    return subscribeBrowserMirror(serverId, remoteBrowserId, ({ action, origin }) => {
      if (origin === MIRROR_ORIGIN) return;
      queue = queue.then(() => replay(action)).catch(() => undefined);
    });
  }, [enabled, localBrowserId, remoteBrowserId, serverId, workspaceId]);

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
  // The desktop app shows every tab in its own browser; a daemon tab's actions are
  // replayed here. Phones and the web stream daemon tabs instead.
  const mirrorsLocally = getIsElectron() && !handoff;
  useBrowserMirror({
    serverId,
    workspaceId,
    remoteBrowserId,
    localBrowserId: target.browserId,
    enabled: mirrorsLocally,
  });
  if (mirrorsLocally) {
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

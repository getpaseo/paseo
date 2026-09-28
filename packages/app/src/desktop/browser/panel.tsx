import { useEffect, useMemo } from "react";
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
import { mirrorReplaySource, subscribeBrowserMirror } from "@/desktop/browser/mirror";
import { getDesktopHost } from "@/desktop/host";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { DEFAULT_BROWSER_URL } from "@/desktop/browser/store/state";

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

/**
 * Replays a daemon tab's actions in this app's own browser: the page is loaded here and
 * each click or keystroke is repeated on the same element, so nothing is streamed.
 */
function useBrowserMirrorReplay(input: {
  serverId: string;
  workspaceId: string;
  remoteBrowserId: string | null;
  localBrowserId: string;
  enabled: boolean;
}) {
  const { serverId, workspaceId, remoteBrowserId, localBrowserId, enabled } = input;
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
    return subscribeBrowserMirror(serverId, remoteBrowserId, ({ action }) => {
      queue = queue.then(() => replay(action)).catch(() => undefined);
    });
  }, [enabled, localBrowserId, remoteBrowserId, serverId, workspaceId]);
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
  useBrowserMirrorReplay({
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

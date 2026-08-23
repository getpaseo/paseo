import { useCallback, useEffect, useState } from "react";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export interface RemoteBrowserTab {
  url: string;
  title: string;
  hostLabel: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface RemoteBrowserTabView {
  tab: RemoteBrowserTab | null;
  run: (command: BrowserAutomationCommand) => void;
}

/**
 * Tab metadata for a browser owned by another host. Refreshed on mount and
 * after each navigation, so a page that navigates itself lags until the next
 * command.
 * ponytail: pull-on-change, switch to a daemon push if the lag shows.
 */
export function useRemoteBrowserTab(
  serverId: string,
  workspaceId: string,
  browserId: string,
): RemoteBrowserTabView {
  const client = useHostRuntimeClient(serverId);
  const [tab, setTab] = useState<RemoteBrowserTab | null>(null);

  const refresh = useCallback(async () => {
    if (!client) {
      return;
    }
    const payload = await client.runBrowserCommand({
      command: { command: "list_tabs", args: {} },
      workspaceId,
    });
    if (!payload.ok || payload.result.command !== "list_tabs") {
      return;
    }
    const match = payload.result.tabs.find((entry) => entry.browserId === browserId);
    setTab(
      match
        ? {
            url: match.url,
            title: match.title,
            hostLabel: match.hostLabel ?? null,
            canGoBack: match.canGoBack ?? false,
            canGoForward: match.canGoForward ?? false,
          }
        : null,
    );
  }, [browserId, client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    (command: BrowserAutomationCommand) => {
      if (!client) {
        return;
      }
      void (async () => {
        await client.runBrowserCommand({ command, workspaceId });
        await refresh();
      })();
    },
    [client, refresh, workspaceId],
  );

  return { tab, run };
}

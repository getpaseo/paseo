import { useCallback, useMemo } from "react";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  findWorkspaceBrowserTab,
  useWorkspaceBrowsers,
} from "@/desktop/browser/use-workspace-browsers";

export interface RemoteBrowserTab {
  url: string;
  title: string;
  hostLabel: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface RemoteBrowserTabView {
  tab: RemoteBrowserTab | null;
  run: (command: BrowserAutomationCommand) => void;
}

/**
 * Tab metadata for a browser owned by another host, read from the workspace tab
 * list the daemon pushes on every change.
 */
export function useRemoteBrowserTab(
  serverId: string,
  workspaceId: string,
  browserId: string,
): RemoteBrowserTabView {
  const client = useHostRuntimeClient(serverId);
  const { tabs } = useWorkspaceBrowsers({ serverId, workspaceId });

  const tab = useMemo<RemoteBrowserTab | null>(() => {
    const match = findWorkspaceBrowserTab(tabs, browserId);
    if (!match) {
      return null;
    }
    return {
      url: match.url,
      title: match.title,
      hostLabel: match.hostLabel ?? null,
      isLoading: match.isLoading,
      canGoBack: match.canGoBack ?? false,
      canGoForward: match.canGoForward ?? false,
    };
  }, [browserId, tabs]);

  const run = useCallback(
    (command: BrowserAutomationCommand) => {
      if (!client) {
        return;
      }
      void client.runBrowserCommand({ command, workspaceId });
    },
    [client, workspaceId],
  );

  return { tab, run };
}

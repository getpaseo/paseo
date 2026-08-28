import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { BrowserAutomationTabInfo } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { useReplicaQuery } from "@/data/query";
import { workspaceBrowsersQueryKey, type WorkspaceBrowserTabs } from "@/data/browsers";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useBrowserMirror } from "@/desktop/browser/capability";

const NO_BROWSER_TABS: WorkspaceBrowserTabs = [];

export interface WorkspaceBrowsersView {
  query: UseQueryResult<WorkspaceBrowserTabs, Error>;
  tabs: WorkspaceBrowserTabs;
  browserIds: string[];
  isHydrated: boolean;
}

/**
 * The browser tabs of one workspace, wherever they are hosted. Seeded by a
 * `list_tabs` fan-out and kept current by the daemon's `browser.tabs.changed`
 * push, which is how a tab opened on the host reaches every other client.
 */
export function useWorkspaceBrowsers(input: {
  serverId: string;
  workspaceId: string;
}): WorkspaceBrowsersView {
  const { serverId, workspaceId } = input;
  const client = useHostRuntimeClient(serverId);
  const hasBrowserMirror = useBrowserMirror(serverId);
  const enabled = Boolean(client) && hasBrowserMirror && workspaceId.length > 0;

  const query = useReplicaQuery({
    queryKey: workspaceBrowsersQueryKey(serverId, workspaceId),
    enabled,
    pushEvent: "browser.tabs.changed",
    queryFn: async (): Promise<WorkspaceBrowserTabs> => {
      if (!client) {
        throw new Error("Browser mirror host is not connected");
      }
      const payload = await client.runBrowserCommand({
        command: { command: "list_tabs", args: {} },
        workspaceId,
      });
      if (!payload.ok) {
        throw new Error(payload.error.message);
      }
      if (payload.result.command !== "list_tabs") {
        throw new Error("Browser host answered list_tabs with another command");
      }
      return payload.result.tabs;
    },
  });

  const tabs = query.data ?? NO_BROWSER_TABS;
  const browserIds = useMemo(() => tabs.map((tab) => tab.browserId), [tabs]);

  return { query, tabs, browserIds, isHydrated: query.isSuccess };
}

export function findWorkspaceBrowserTab(
  tabs: WorkspaceBrowserTabs,
  browserId: string,
): BrowserAutomationTabInfo | null {
  return tabs.find((tab) => tab.browserId === browserId) ?? null;
}

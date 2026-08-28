import type { QueryKey } from "@tanstack/react-query";
import type { BrowserAutomationTabInfo } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { queryClient } from "@/data/query-client";

export type WorkspaceBrowserTabs = BrowserAutomationTabInfo[];

export function workspaceBrowsersQueryKey(serverId: string, workspaceId: string) {
  return ["browsers", serverId, workspaceId] as const;
}

/**
 * Drops closed tabs from the cached tab lists. The layout reconciles against a
 * snapshot built from this cache, so a tab that is gone from here is gone from
 * the next reconcile and cannot be adopted back. Deliberately no invalidate:
 * the host may not have processed the close yet, and forcing a refetch is how
 * the closed tab reappears. The host's own announcement corrects the list.
 */
export function removeWorkspaceBrowsersFromQueryCache(browserIds: Iterable<string>): void {
  const removed = new Set(browserIds);
  if (removed.size === 0) return;
  queryClient.setQueriesData<WorkspaceBrowserTabs>({ queryKey: ["browsers"] }, (tabs) =>
    tabs?.filter((tab) => !removed.has(tab.browserId)),
  );
}

export function readWorkspaceBrowsersQueryWorkspaceId(
  queryKey: QueryKey,
  serverId: string,
): string | null {
  if (queryKey.length !== 3 || queryKey[0] !== "browsers" || queryKey[1] !== serverId) {
    return null;
  }
  const workspaceId = queryKey[2];
  return typeof workspaceId === "string" ? workspaceId : null;
}

import type { QueryKey } from "@tanstack/react-query";
import type { BrowserAutomationTabInfo } from "@getpaseo/protocol/browser-automation/rpc-schemas";

export type WorkspaceBrowserTabs = BrowserAutomationTabInfo[];

export function workspaceBrowsersQueryKey(serverId: string, workspaceId: string) {
  return ["browsers", serverId, workspaceId] as const;
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

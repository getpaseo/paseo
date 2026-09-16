import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () => ({
      openAgent: ({ agentId, serverId: targetServerId }) =>
        navigateToAgent({ serverId: targetServerId ?? serverId, agentId }),
      openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
        navigateToWorkspace({ serverId: targetServerId ?? serverId, workspaceId }),
    }),
    [serverId],
  );
}

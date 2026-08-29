import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () => ({
      openAgent: ({ agentId }) => navigateToAgent({ serverId, agentId }),
      openWorkspace: ({ workspaceId }) => navigateToWorkspace({ serverId, workspaceId }),
    }),
    [serverId],
  );
}

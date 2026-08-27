import type { PluginHostProps } from "@getpaseo/plugin";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function usePluginNavigation(serverId: string): NonNullable<PluginHostProps["navigation"]> {
  return useMemo(
    () => ({
      openAgent: ({ agentId }) => navigateToAgent({ serverId, agentId }),
      openWorkspace: ({ workspaceId }) => navigateToWorkspace({ serverId, workspaceId }),
    }),
    [serverId],
  );
}

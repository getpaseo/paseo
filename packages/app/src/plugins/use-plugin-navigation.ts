import type { PluginHostProps } from "@getpaseo/plugin";
import { useMemo } from "react";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function usePluginNavigation(serverId: string): NonNullable<PluginHostProps["navigation"]> {
  return useMemo(
    () => ({ openAgent: (agentId: string) => navigateToAgent({ serverId, agentId }) }),
    [serverId],
  );
}

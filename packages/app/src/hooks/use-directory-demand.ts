import { useEffect } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * Keeps a host's directory demanded while the caller is mounted.
 *
 * The sidebar only demands the directory while its panel is active, so a compact app that
 * restores straight into a workspace or agent route has nothing else asking the host for
 * workspaces and agents. Without demand the route waits on hydration that never starts.
 */
export function useDirectoryDemand(serverId: string | null | undefined): void {
  useEffect(() => {
    if (!serverId) return;
    return getHostRuntimeStore().acquireDirectoryDemand(serverId);
  }, [serverId]);
}

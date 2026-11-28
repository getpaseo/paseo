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

/**
 * Holds directory demand for several hosts at once, so a caller that needs the whole fleet
 * (the favicon, the aggregated agent list) does not have to subscribe to every agent map to
 * keep the directories loading.
 */
export function useAllDirectoryDemand(input: {
  serverIds: readonly string[];
  enabled: boolean;
}): void {
  const { serverIds, enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    const runtime = getHostRuntimeStore();
    const releases = serverIds.map((serverId) => runtime.acquireDirectoryDemand(serverId));
    return () => releases.forEach((release) => release());
  }, [enabled, serverIds]);
}

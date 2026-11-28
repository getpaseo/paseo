import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useHosts } from "@/runtime/host-runtime";
import { useLocalDaemonServerId, useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { selectHostBadges, type HostBadgeModel } from "@/hosts/appearance";
import { useSessionStore } from "@/stores/session-store";

/**
 * Every host's badge, resolved from the host registry, local-host detection, daemon-reported
 * machine kind, and each host's own appearance. `enabled` is the caller's own "off" — a surface
 * that has its own reason to hide badges passes false rather than filtering the result, so the
 * per-host setting stays the only thing that decides name vs icon vs hidden.
 */
export function useHostBadges({
  enabled,
}: {
  enabled: boolean;
}): ReadonlyMap<string, HostBadgeModel> {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const localDaemon = useLocalDaemonServerIdState();
  const detectedMachineKinds = useSessionStore(
    useShallow((state) => {
      const result: Record<string, string | null> = {};
      for (const host of hosts) {
        result[host.serverId] = state.sessions[host.serverId]?.serverInfo?.machineKind ?? null;
      }
      return result;
    }),
  );
  return useMemo(() => {
    const detectedMachineKindByServerId = new Map<string, string | null>(
      Object.entries(detectedMachineKinds),
    );
    return selectHostBadges({
      hosts,
      localServerId,
      localHostResolutionPending: localDaemon.status !== "resolved",
      detectedMachineKindByServerId,
      enabled,
    });
  }, [hosts, localDaemon.status, localServerId, detectedMachineKinds, enabled]);
}

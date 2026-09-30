import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useLocalDaemonServerId, useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import {
  resolveHostIcon,
  selectHostBadges,
  type HostBadgeModel,
  type HostIcon,
} from "@/hosts/appearance";

/**
 * Every host's badge, resolved from the three things that decide one: the host registry, which
 * host is local, and each host's own appearance. `enabled` is the caller's own "off" — a surface
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
  const icons = useSessionStore(
    useShallow((state) =>
      hosts.map((host) => resolveHostIcon(state.sessions[host.serverId]?.serverInfo?.hostIcon)),
    ),
  );
  const hostIcons = useMemo(
    () => new Map<string, HostIcon>(hosts.map((host, index) => [host.serverId, icons[index]!])),
    [hosts, icons],
  );
  return useMemo(
    () =>
      selectHostBadges({
        hosts,
        localServerId,
        localHostResolutionPending: localDaemon.status !== "resolved",
        hostIcons,
        enabled,
      }),
    [hosts, localDaemon.status, localServerId, hostIcons, enabled],
  );
}

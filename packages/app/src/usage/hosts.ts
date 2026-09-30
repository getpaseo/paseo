import { useMemo, useState } from "react";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { resolveUsageHostId, resolveUsageScreenHostId, type UsageHost } from "./model";
import { useUsageHosts } from "./queries";

/** The active workspace's host; off a workspace route, the last workspace visited. */
function useActiveServerId(): string | null {
  const active = useActiveWorkspaceSelection();
  const last = useLastWorkspaceSelection();
  return active?.serverId ?? last?.serverId ?? null;
}

/** The host the sidebar Usage row reads, or null when none reports usage. */
export function useUsageHostId(): string | null {
  return resolveUsageHostId(useActiveServerId(), useUsageHosts());
}

/**
 * The host the Usage screen or the compact usage sheet shows, and the hosts to pick from. The pick
 * is the view's state: it resets when the view unmounts.
 */
export function useUsageHostSelection(): {
  serverId: string | null;
  connectedHosts: UsageHost[];
  select: (serverId: string) => void;
} {
  const hosts = useUsageHosts();
  const activeServerId = useActiveServerId();
  const [selectedServerId, select] = useState<string | null>(null);
  const connectedHosts = useMemo(() => hosts.filter((host) => host.isConnected), [hosts]);
  return {
    serverId: resolveUsageScreenHostId({ selectedServerId, activeServerId, hosts }),
    connectedHosts,
    select,
  };
}

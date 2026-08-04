import { useMemo } from "react";
import { useLocalSearchParams, usePathname } from "expo-router";

import { useHostFeatureMap } from "@/runtime/host-features";
import { parseActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store/navigation";

function useRouteServerId(): string | null {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const pathname = usePathname();
  // Read-only: unlike `useActiveWorkspaceSelection`, this must not also record
  // the workspace as "last visited" — that stays owned by the workspace screen.
  return parseActiveWorkspaceSelection({ pathname, params })?.serverId ?? null;
}

/**
 * Which host synthesizes the speech.
 *
 * The turn is spoken by the host that owns the route it came from, never another
 * paired daemon. The text being read *is* workspace content — code, agent output
 * — so sending it to a different host would disclose it across an independently
 * paired daemon boundary. There is deliberately no fallback: a route host that
 * doesn't advertise the capability shows no button, and so does a route with no
 * host at all (settings, history).
 *
 * Reachability is not checked here: the daemon client resolves to `null` before
 * it has a transport, and a host that drops mid-request surfaces the failure on
 * the button.
 */
export function useReadAloudServerId(): string | null {
  const routeServerId = useRouteServerId();
  const serverIds = useMemo(() => (routeServerId ? [routeServerId] : []), [routeServerId]);
  const featureByServerId = useHostFeatureMap(serverIds, "readAloud");

  if (!routeServerId) {
    return null;
  }
  return featureByServerId.get(routeServerId) === true ? routeServerId : null;
}

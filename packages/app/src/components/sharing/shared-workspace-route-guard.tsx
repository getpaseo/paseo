import { useEffect } from "react";
import { router, usePathname } from "expo-router";
import {
  acknowledgeSessionEnded,
  useSharedSessionStore,
  useSharedWorkspaceScope,
} from "@/stores/shared-session-store";
import {
  buildHostWorkspaceRoute,
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

/**
 * Client-side enforcement for recipients of a workspace share link.
 *
 * When a recipient entered via /join-workspace/:token, their `useSharedWorkspaceScope()`
 * is populated with { serverId, workspaceId }. This component watches the pathname and
 * redirects the user back to their scoped workspace if they try to navigate elsewhere
 * (e.g. via the address bar, history, or an in-app link).
 *
 * NOTE: This is defense-in-depth, NOT a security boundary. The recipient still has a
 * direct WebSocket connection to the owner's daemon via the relay and could in theory
 * send arbitrary messages. A full backend guardrail requires:
 *   - Daemon-side scoping by share token (only return data for the allowed workspace)
 *   - Relay-level auth handshake that binds the socket to a specific workspace scope
 * Both are architectural changes outside this client-only patch.
 */
export function SharedWorkspaceRouteGuard() {
  const pathname = usePathname();
  const scope = useSharedWorkspaceScope();
  const { sessionEnded } = useSharedSessionStore();

  // When the share ends (owner revoked / Colyseus room disposed), the
  // recipient may still be sitting on a /h/<serverId>/... URL with the host
  // connection cached. Force them home so they can't keep viewing the
  // workspace after the session died.
  useEffect(() => {
    if (!sessionEnded) return;
    if (!pathname) return;
    if (
      parseHostWorkspaceRouteFromPathname(pathname) ||
      parseHostAgentRouteFromPathname(pathname)
    ) {
      router.replace("/");
    }
    // Consume the flag so we don't re-evict on every subsequent navigation.
    // The redirect above only needs to fire once per share ending; after that
    // the user should be free to move around their remaining hosts without
    // bouncing back to `/` on every route change.
    acknowledgeSessionEnded();
  }, [sessionEnded, pathname]);

  useEffect(() => {
    if (!scope.serverId || !scope.workspaceId) return;
    if (!pathname) return;

    // Always allow the scoped workspace and its nested agents.
    const wsRoute = parseHostWorkspaceRouteFromPathname(pathname);
    if (wsRoute) {
      if (wsRoute.serverId === scope.serverId && wsRoute.workspaceId === scope.workspaceId) {
        return;
      }
    }

    const agentRoute = parseHostAgentRouteFromPathname(pathname);
    if (agentRoute && agentRoute.serverId === scope.serverId) {
      // Agents belong to workspaces; the agent screen will itself be scoped via the
      // workspace redirect when the user selects a tab. Tolerate it here.
      return;
    }

    // Allow the join-workspace and settings routes so the user can re-enter the flow
    // and the settings/about pages remain reachable if we ever link to them.
    if (pathname.startsWith("/join-workspace/")) return;

    // Anything else — bounce back to the scoped workspace.
    router.replace(buildHostWorkspaceRoute(scope.serverId, scope.workspaceId));
  }, [pathname, scope.serverId, scope.workspaceId]);

  return null;
}

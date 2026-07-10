import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export default function HostAgentReadyRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAgentReadyRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostAgentReadyRouteContent() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
  }>();
  const redirectedRef = useRef(false);
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : "";
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentWorkspaceId = useSessionStore((state) => {
    if (!serverId || !agentId) {
      return null;
    }
    return state.sessions[serverId]?.agents?.get(agentId)?.workspaceId ?? null;
  });
  const hasHydratedWorkspaces = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const resolvedWorkspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      redirectedRef.current = true;
      router.replace("/" as Href);
      return;
    }

    if (resolvedWorkspaceId) {
      redirectedRef.current = true;
      navigateToAgent({
        serverId,
        agentId,
      });
    }
  }, [agentId, resolvedWorkspaceId, router, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      return;
    }
    if (agentWorkspaceId && !hasHydratedWorkspaces) {
      return;
    }
    if (!client || !isConnected) {
      redirectedRef.current = true;
      router.replace(buildHostRootRoute(serverId));
    }
  }, [agentWorkspaceId, agentId, client, hasHydratedWorkspaces, isConnected, router, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId || !client || !isConnected) {
      return;
    }

    let cancelled = false;
    void client
      .fetchAgent({ agentId })
      .then((result) => {
        if (cancelled || redirectedRef.current) {
          return;
        }
        const workspaceId = normalizeWorkspaceOpaqueId(result?.agent?.workspaceId);
        redirectedRef.current = true;
        if (workspaceId) {
          navigateToAgent({
            serverId,
            agentId,
            workspaceId,
          });
          return;
        }
        router.replace(buildHostRootRoute(serverId));
        return;
      })
      .catch(() => {
        if (cancelled || redirectedRef.current) {
          return;
        }
        redirectedRef.current = true;
        router.replace(buildHostRootRoute(serverId));
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, client, isConnected, router, serverId]);

  return null;
}

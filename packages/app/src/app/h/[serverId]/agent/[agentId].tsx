import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useSessionStore } from "@/stores/session-store";
import { useResolveWorkspaceIdByCwd } from "@/stores/session-store-hooks";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

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
  const agentCwd = useSessionStore((state) => {
    if (!serverId || !agentId) {
      return null;
    }
    return state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? null;
  });
  const hasHydratedWorkspaces = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const resolvedWorkspaceId = useResolveWorkspaceIdByCwd(serverId, agentCwd);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      redirectedRef.current = true;
      router.replace("/" as any);
      return;
    }

    if (resolvedWorkspaceId) {
      redirectedRef.current = true;
      router.replace(
        prepareWorkspaceTab({
          serverId,
          workspaceId: resolvedWorkspaceId,
          target: { kind: "agent", agentId },
        }) as any,
      );
    }
  }, [agentId, resolvedWorkspaceId, router, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      return;
    }
    if (agentCwd?.trim() && !hasHydratedWorkspaces) {
      return;
    }
    if (!client || !isConnected) {
      redirectedRef.current = true;
      router.replace(buildHostRootRoute(serverId));
    }
  }, [agentCwd, agentId, client, hasHydratedWorkspaces, isConnected, router, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId || !client || !isConnected) {
      return;
    }

    let cancelled = false;
    void client
      .fetchAgent(agentId)
      .then((result) => {
        if (cancelled || redirectedRef.current) {
          return;
        }
        const cwd = result?.agent?.cwd?.trim();
        const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
        const workspaceId = resolveWorkspaceIdByExecutionDirectory({
          workspaces: workspaces?.values(),
          workspaceDirectory: cwd,
        });
        if (!workspaceId && !hasHydratedWorkspaces) {
          return;
        }
        redirectedRef.current = true;
        if (workspaceId) {
          router.replace(
            prepareWorkspaceTab({
              serverId,
              workspaceId,
              target: { kind: "agent", agentId },
            }) as any,
          );
          return;
        }
        router.replace(buildHostRootRoute(serverId));
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
  }, [agentId, client, hasHydratedWorkspaces, isConnected, router, serverId]);

  return null;
}

import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

export default function HostAgentReadyRoute() {
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

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      redirectedRef.current = true;
      router.replace("/" as any);
      return;
    }

    const normalizedCwd = agentCwd?.trim();
    if (normalizedCwd) {
      redirectedRef.current = true;
      router.replace(
        prepareWorkspaceTab({
          serverId,
          workspaceId: normalizedCwd,
          target: { kind: "agent", agentId },
        }) as any,
      );
    }
  }, [agentCwd, agentId, router, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      return;
    }
    if (agentCwd?.trim()) {
      return;
    }
    if (!client || !isConnected) {
      redirectedRef.current = true;
      router.replace(buildHostRootRoute(serverId));
    }
  }, [agentCwd, agentId, client, isConnected, router, serverId]);

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
        redirectedRef.current = true;
        if (cwd) {
          router.replace(
            prepareWorkspaceTab({
              serverId,
              workspaceId: cwd,
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
  }, [agentId, client, isConnected, router, serverId]);

  return null;
}

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useLocalSearchParams, useRouter } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useSessionStore } from "@/stores/session-store";
import { useResolveWorkspaceIdByCwd } from "@/stores/session-store-hooks";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = 15_000;

function dbg(label: string, data?: Record<string, unknown>) {
  console.log(`[agent-route] ${label}`, data ? JSON.stringify(data) : "");
}

export default function HostAgentReadyRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAgentReadyRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostAgentReadyRouteContent() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
  }>();
  const redirectedRef = useRef(false);
  const [bootstrapTimedOut, setBootstrapTimedOut] = useState(false);
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
  const hasHydratedAgents = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.hasHydratedAgents ?? false) : false,
  );
  const hasHydratedWorkspaces = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const agentsCount = useSessionStore((state) => {
    if (!serverId) return 0;
    return state.sessions[serverId]?.agents?.size ?? 0;
  });
  const workspacesCount = useSessionStore((state) => {
    if (!serverId) return 0;
    return state.sessions[serverId]?.workspaces?.size ?? 0;
  });
  const resolvedWorkspaceId = useResolveWorkspaceIdByCwd(serverId, agentCwd);

  useEffect(() => {
    dbg("state-snapshot", {
      serverId,
      agentId,
      isConnected,
      hasClient: !!client,
      agentCwd: agentCwd ?? "(null)",
      hasHydratedAgents,
      hasHydratedWorkspaces,
      agentsCount,
      workspacesCount,
      resolvedWorkspaceId: resolvedWorkspaceId ?? "(null)",
      bootstrapTimedOut,
      redirected: redirectedRef.current,
    });
  }, [
    serverId,
    agentId,
    isConnected,
    client,
    agentCwd,
    hasHydratedAgents,
    hasHydratedWorkspaces,
    agentsCount,
    workspacesCount,
    resolvedWorkspaceId,
    bootstrapTimedOut,
  ]);

  useEffect(() => {
    setBootstrapTimedOut(false);
  }, [agentId, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId || resolvedWorkspaceId) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setBootstrapTimedOut(true);
    }, WORKSPACE_BOOTSTRAP_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [agentId, resolvedWorkspaceId, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId) {
      dbg("redirect: missing params");
      redirectedRef.current = true;
      router.replace("/" as any);
      return;
    }

    if (resolvedWorkspaceId) {
      dbg("redirect: workspace resolved", { resolvedWorkspaceId });
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
    if (bootstrapTimedOut) {
      dbg("redirect: bootstrap timed out");
      redirectedRef.current = true;
      router.replace(buildHostRootRoute(serverId));
      return;
    }
    if (agentCwd?.trim() && !hasHydratedWorkspaces) {
      dbg("waiting: agentCwd present but workspaces not hydrated");
      return;
    }
    if (!client || !isConnected) {
      dbg("redirect: no client or not connected", { hasClient: !!client, isConnected });
      redirectedRef.current = true;
      router.replace(buildHostRootRoute(serverId));
    }
  }, [agentCwd, agentId, bootstrapTimedOut, client, hasHydratedWorkspaces, isConnected, router, serverId]);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    if (!serverId || !agentId || !client || !isConnected) {
      return;
    }

    dbg("fetchAgent: starting", { agentId });
    let cancelled = false;
    void client
      .fetchAgent(agentId)
      .then((result) => {
        if (cancelled || redirectedRef.current) {
          return;
        }
        dbg("fetchAgent: result", {
          hasAgent: !!result?.agent,
          cwd: result?.agent?.cwd ?? "(null)",
        });
        const cwd = result?.agent?.cwd?.trim();
        const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
        dbg("fetchAgent: workspace state", {
          hasWorkspaces: !!workspaces,
          workspaceCount: workspaces?.size ?? 0,
          hasHydratedWorkspaces:
            useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces ?? false,
        });
        const workspaceId = resolveWorkspaceIdByExecutionDirectory({
          workspaces: workspaces?.values(),
          workspaceDirectory: cwd,
        });
        dbg("fetchAgent: resolved", { workspaceId: workspaceId ?? "(null)" });
        if (!workspaceId && !hasHydratedWorkspaces) {
          dbg("fetchAgent: waiting for workspace hydration");
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
        dbg("fetchAgent: fallback redirect to host root");
        router.replace(buildHostRootRoute(serverId));
      })
      .catch((err) => {
        if (cancelled || redirectedRef.current) {
          return;
        }
        dbg("fetchAgent: error", { error: err instanceof Error ? err.message : String(err) });
        redirectedRef.current = true;
        router.replace(buildHostRootRoute(serverId));
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, client, hasHydratedWorkspaces, isConnected, router, serverId]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
      <Text style={styles.message}>
        {bootstrapTimedOut ? "Session took too long to load. Redirecting…" : "Opening session…"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    fontSize: theme.fontSize.sm,
  },
}));

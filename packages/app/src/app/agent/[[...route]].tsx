import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { DraftAgentScreen } from "@/screens/agent/draft-agent-screen";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";
import { LegacyAgentIdScreen } from "@/screens/agent/legacy-agent-id-screen";
import { useSessionStore } from "@/stores/session-store";

type AgentRouteParams = {
  route?: string[] | string;
};

function normalizeSegments(raw: AgentRouteParams["route"]): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.length > 0);
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  return [];
}

type RouteKind = "draft" | "legacy" | "ready";

export default function AgentRoute() {
  const params = useLocalSearchParams<AgentRouteParams>();
  const segments = useMemo(() => normalizeSegments(params.route), [params.route]);

  const routeKind: RouteKind =
    segments.length === 0 ? "draft" : segments.length === 1 ? "legacy" : "ready";
  const legacyAgentId = segments.length === 1 ? segments[0] : "";
  const serverId = segments.length >= 2 ? segments[0] : "";
  const agentId = segments.length >= 2 ? segments[1] : "";

  const agent = useSessionStore((state) =>
    serverId && agentId ? state.sessions[serverId]?.agents?.get(agentId) : undefined
  );
  const isInitializingFromMap = useSessionStore((state) =>
    serverId && agentId
      ? state.sessions[serverId]?.initializingAgents?.get(agentId) ?? false
      : false
  );
  const isInitializing = agentId ? isInitializingFromMap !== false : false;
  const isAgentReady = Boolean(agent && !isInitializing);

  const [createFlowActive, setCreateFlowActive] = useState(false);
  const [shouldMountDraft, setShouldMountDraft] = useState(routeKind === "draft");

  useEffect(() => {
    if (routeKind === "draft") {
      setShouldMountDraft(true);
    }
  }, [routeKind]);

  const ensureAgentIsInitialized = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.methods?.ensureAgentIsInitialized : undefined
  );
  const isConnected = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.connection.isConnected ?? false : false
  );

  useEffect(() => {
    if (routeKind !== "ready") return;
    if (!agentId || !ensureAgentIsInitialized) return;
    if (!isConnected) return;

    ensureAgentIsInitialized(agentId).catch((error) => {
      console.warn("[AgentRoute] Agent initialization failed", {
        agentId,
        serverId,
        error,
      });
    });
  }, [agentId, ensureAgentIsInitialized, isConnected, routeKind, serverId]);

  useEffect(() => {
    if (routeKind !== "ready") {
      return;
    }
    if (createFlowActive && isAgentReady) {
      setCreateFlowActive(false);
    }
  }, [createFlowActive, isAgentReady, routeKind]);

  if (routeKind === "legacy") {
    return <LegacyAgentIdScreen agentId={legacyAgentId} />;
  }

  const shouldShowDraft =
    routeKind === "draft" || (routeKind === "ready" && createFlowActive && !isAgentReady);
  const shouldShowReady = routeKind === "ready" && (!createFlowActive || isAgentReady);

  return (
    <View style={styles.container}>
      {shouldShowReady ? <AgentReadyScreen serverId={serverId} agentId={agentId} /> : null}
      {shouldMountDraft && shouldShowDraft ? (
        <DraftAgentScreen
          isVisible={shouldShowDraft}
          onCreateFlowActiveChange={setCreateFlowActive}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));

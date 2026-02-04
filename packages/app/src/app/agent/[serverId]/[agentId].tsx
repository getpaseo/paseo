import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";
import { resolveCanonicalDaemonId, useDaemonRegistry } from "@/contexts/daemon-registry-context";

export default function AgentReadyRoute() {
  const router = useRouter();
  const { daemons } = useDaemonRegistry();
  const { serverId, agentId } = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
  }>();

  useEffect(() => {
    if (typeof serverId !== "string" || typeof agentId !== "string") return;
    const canonical = resolveCanonicalDaemonId(daemons, serverId);
    if (!canonical || canonical === serverId) return;
    router.replace(`/agent/${canonical}/${agentId}` as any);
  }, [agentId, daemons, router, serverId]);

  return (
    <AgentReadyScreen
      serverId={typeof serverId === "string" ? serverId : ""}
      agentId={typeof agentId === "string" ? agentId : ""}
    />
  );
}

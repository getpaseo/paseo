import { useCallback, useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  createSetAgentInitializing,
  ensureAgentIsInitialized as ensureAgentIsInitializedPure,
  refreshAgent as refreshAgentPure,
} from "./use-agent-initialization.pure";

export function useAgentInitialization({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient | null;
}) {
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const setAgentInitializing = useMemo(
    () => createSetAgentInitializing(serverId, setInitializingAgents),
    [serverId, setInitializingAgents],
  );

  const ensureAgentIsInitialized = useCallback(
    (agentId: string): Promise<void> =>
      ensureAgentIsInitializedPure({ serverId, agentId, client, setAgentInitializing }),
    [client, serverId, setAgentInitializing],
  );

  const refreshAgent = useCallback(
    (agentId: string): Promise<void> => refreshAgentPure({ agentId, client, setAgentInitializing }),
    [client, setAgentInitializing],
  );

  return { ensureAgentIsInitialized, refreshAgent };
}

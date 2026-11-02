import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentTeamsConfigWire } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";

export interface UseAgentTeamsConfigResult {
  /** `null` until the daemon config has arrived. */
  teams: AgentTeamsConfigWire | null;
  /** False on daemons that cannot edit teams through the config RPC. */
  isSupported: boolean;
  /** Writes the whole record; there is no per-team RPC. */
  saveTeams: (next: AgentTeamsConfigWire) => Promise<void>;
}

export function useAgentTeamsConfig(serverId: string): UseAgentTeamsConfigResult {
  const queryClient = useQueryClient();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const isSupported = useHostFeature(serverId, "agentTeamsConfig");

  const saveTeams = useCallback(
    async (next: AgentTeamsConfigWire) => {
      await patchConfig({ teams: next });
      // The composer's Team selector lists resolved teams through its own query.
      await queryClient.invalidateQueries({ queryKey: ["host", serverId, "agent-teams"] });
    },
    [patchConfig, queryClient, serverId],
  );

  return {
    teams: config ? (config.teams ?? {}) : null,
    isSupported,
    saveTeams,
  };
}

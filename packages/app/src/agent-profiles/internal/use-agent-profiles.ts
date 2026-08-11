import { useCallback } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.agentProfiles === true,
  );

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await patchConfig({ agentProfiles: next });
    },
    [patchConfig],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    isSupported,
    saveProfiles,
  };
}

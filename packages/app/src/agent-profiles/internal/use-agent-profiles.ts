import { useCallback } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useServerFeature } from "@/stores/session-store-hooks";

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
  const supportsProfiles = useServerFeature(serverId, "agentProfiles");
  const supportsApply = useServerFeature(serverId, "agentConfigApply");
  const isSupported = supportsProfiles && supportsApply;

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

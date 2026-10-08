import { useCallback } from "react";
import type { AgentProfile, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { supportsAgentProfiles } from "./capabilities";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  /** Replaces the preset list within the selected settings profile. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
}

interface CreateAgentProfilesPatchInput {
  settingsProfileId: string | undefined;
  activeSettingsProfileId: string | undefined;
  agentProfiles: AgentProfile[];
}

export function createAgentProfilesPatch({
  settingsProfileId,
  activeSettingsProfileId,
  agentProfiles,
}: CreateAgentProfilesPatchInput): MutableDaemonConfigPatch {
  const profileId = settingsProfileId ?? activeSettingsProfileId;
  return profileId
    ? { agentSettingsProfilePatch: { profileId, agentProfiles } }
    : { agentProfiles };
}

export function useAgentProfiles(
  serverId: string | null,
  settingsProfileId?: string,
): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const isSupported = useSessionStore((state) => {
    return supportsAgentProfiles(state.sessions[serverId ?? ""]?.serverInfo?.features);
  });

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      const activeSettingsProfileId = config?.agentSettingsProfiles?.activeProfileId;
      if (!activeSettingsProfileId) {
        if (settingsProfileId && settingsProfileId !== "default")
          throw new Error("Agent settings profile does not exist");
        await patchConfig(
          createAgentProfilesPatch({
            settingsProfileId: undefined,
            activeSettingsProfileId: undefined,
            agentProfiles: next,
          }),
        );
        return;
      }
      await patchConfig(
        createAgentProfilesPatch({
          settingsProfileId,
          activeSettingsProfileId,
          agentProfiles: next,
        }),
      );
    },
    [config?.agentSettingsProfiles?.activeProfileId, patchConfig, settingsProfileId],
  );

  const configuredProfiles =
    settingsProfileId && config?.agentSettingsProfiles
      ? config?.agentSettingsProfiles?.profiles.find((profile) => profile.id === settingsProfileId)
          ?.settings.agentProfiles
      : config?.agentProfiles;
  return {
    profiles: config ? (configuredProfiles ?? []) : null,
    isSupported,
    saveProfiles,
  };
}

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentProfile, MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { supportsAgentProfiles } from "./capabilities";
import {
  createAgentProfileWriteQueue,
  removeAgentProfileById,
  type AgentProfileListUpdater,
} from "./profile-write-queue";

const sharedProfileWriteQueue = createAgentProfileWriteQueue();

export { removeAgentProfileById };
export type { AgentProfileListUpdater };

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
  /**
   * Applies a serialized mutation against the latest host profile list so
   * overlapping writes compose instead of overwriting each other.
   */
  mutateProfiles: (updater: AgentProfileListUpdater) => Promise<AgentProfile[] | null>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);
  const isSupported = useSessionStore((state) => {
    return supportsAgentProfiles(state.sessions[serverId ?? ""]?.serverInfo?.features);
  });

  const mutateProfiles = useCallback(
    async (updater: AgentProfileListUpdater): Promise<AgentProfile[] | null> => {
      if (!serverId) {
        return null;
      }
      return sharedProfileWriteQueue.enqueue(serverId, {
        readCurrent: () => {
          const cached = queryClient.getQueryData<MutableDaemonConfig>(queryKey);
          return cached ? (cached.agentProfiles ?? []) : null;
        },
        write: async (next) => {
          const updated = await patchConfig({ agentProfiles: next });
          if (!updated) {
            throw new Error(t("workspace.terminal.hostDisconnected"));
          }
          return updated.agentProfiles ?? next;
        },
        updater,
      });
    },
    [patchConfig, queryClient, queryKey, serverId, t],
  );

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await mutateProfiles(() => next);
    },
    [mutateProfiles],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    isSupported,
    saveProfiles,
    mutateProfiles,
  };
}

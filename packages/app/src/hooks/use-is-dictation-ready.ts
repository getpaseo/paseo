import { useCallback } from "react";

import type { HostRuntimeAgentDirectoryStatus } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";

function isLegacyDictationReady(agentDirectoryStatus: HostRuntimeAgentDirectoryStatus): boolean {
  return (
    agentDirectoryStatus === "ready" ||
    agentDirectoryStatus === "revalidating" ||
    agentDirectoryStatus === "error_after_ready"
  );
}

export function useIsDictationReady({
  serverId,
  isConnected,
  agentDirectoryStatus,
}: {
  serverId: string;
  isConnected: boolean;
  agentDirectoryStatus: HostRuntimeAgentDirectoryStatus;
}): boolean {
  const dictationCapabilityEnabled = useSessionStore(
    useCallback(
      (state) => {
        const serverInfo = state.sessions[serverId]?.serverInfo ?? null;
        return (
          getVoiceReadinessState({
            serverInfo,
            mode: "dictation",
          })?.enabled ?? null
        );
      },
      [serverId],
    ),
  );

  if (!isConnected) {
    return false;
  }

  return dictationCapabilityEnabled ?? isLegacyDictationReady(agentDirectoryStatus);
}

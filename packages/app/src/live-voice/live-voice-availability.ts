import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { isLiveVoiceSessionSupported } from "@/live-voice/live-voice-session";
import {
  resolveLiveVoiceAvailability,
  type LiveVoiceAvailability,
  type LiveVoiceHostAvailability,
} from "@/live-voice/live-voice-availability-policy";
import { useHosts, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function useLiveVoiceAvailability(): LiveVoiceAvailability {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const serverInfos = useSessionStore(
    useShallow((state) =>
      serverIds.map((serverId) => state.sessions[serverId]?.serverInfo ?? null),
    ),
  );

  return useMemo(() => {
    const hostAvailability = hosts.map((host, index): LiveVoiceHostAvailability => {
      const serverInfo = serverInfos[index] ?? null;
      return {
        serverId: host.serverId,
        label: host.label,
        connectionStatus: connectionStatuses.get(host.serverId) ?? "connecting",
        version: serverInfo?.version ?? null,
        // COMPAT(liveVoice): added in v0.2.5, drop the gate when floor >= v0.2.5.
        supportsLiveVoice: serverInfo ? serverInfo.features?.liveVoice === true : null,
      };
    });
    return resolveLiveVoiceAvailability({
      isPlatformSupported: isLiveVoiceSessionSupported,
      hosts: hostAvailability,
    });
  }, [connectionStatuses, hosts, serverInfos]);
}

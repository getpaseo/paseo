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

/**
 * Every configured host with the facts live voice availability is decided from,
 * unfiltered. `useLiveVoiceAvailability` narrows this to the hosts that can take
 * a call; diagnostics wants the whole list, including the ones that can't.
 */
export function useLiveVoiceHostAvailability(): LiveVoiceHostAvailability[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const serverInfos = useSessionStore(
    useShallow((state) =>
      serverIds.map((serverId) => state.sessions[serverId]?.serverInfo ?? null),
    ),
  );

  return useMemo(
    () =>
      hosts.map((host, index): LiveVoiceHostAvailability => {
        const serverInfo = serverInfos[index] ?? null;
        return {
          serverId: host.serverId,
          label: host.label,
          connectionStatus: connectionStatuses.get(host.serverId) ?? "connecting",
          version: serverInfo?.version ?? null,
          // COMPAT(liveVoice): added in v0.2.5, drop the gate when floor >= v0.2.5.
          supportsLiveVoice: serverInfo ? serverInfo.features?.liveVoice === true : null,
        };
      }),
    [connectionStatuses, hosts, serverInfos],
  );
}

export function useLiveVoiceAvailability(): LiveVoiceAvailability {
  const hostAvailability = useLiveVoiceHostAvailability();

  return useMemo(
    () =>
      resolveLiveVoiceAvailability({
        isPlatformSupported: isLiveVoiceSessionSupported,
        hosts: hostAvailability,
      }),
    [hostAvailability],
  );
}

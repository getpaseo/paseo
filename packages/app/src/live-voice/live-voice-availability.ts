import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { isLiveVoiceSessionSupported } from "@/live-voice/live-voice-session";
import {
  resolveLiveVoiceAvailability,
  type LiveVoiceAvailability,
  type LiveVoiceHostAvailability,
} from "@/live-voice/live-voice-availability-policy";
import {
  getHostRuntimeStore,
  useHosts,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/**
 * Availability read straight from the stores, for callers that live outside
 * React — the Wear bridge, which publishes to the watch on a subscription rather
 * than a render. Same policy as [useLiveVoiceAvailability]; only the plumbing
 * differs, so the wrist and the phone can never disagree about what is callable.
 */
export function readLiveVoiceHostAvailability(): LiveVoiceHostAvailability[] {
  const sessions = useSessionStore.getState().sessions;
  const store = getHostRuntimeStore();
  return store.getHosts().map((host): LiveVoiceHostAvailability => {
    const serverInfo = sessions[host.serverId]?.serverInfo ?? null;
    return {
      serverId: host.serverId,
      label: host.label,
      connectionStatus: store.getSnapshot(host.serverId)?.connectionStatus ?? "connecting",
      version: serverInfo?.version ?? null,
      // COMPAT(liveVoice): added in v0.2.5, drop the gate when floor >= v0.2.5.
      supportsLiveVoice: serverInfo ? serverInfo.features?.liveVoice === true : null,
    };
  });
}

export function readLiveVoiceAvailability(): LiveVoiceAvailability {
  return resolveLiveVoiceAvailability({
    isPlatformSupported: isLiveVoiceSessionSupported,
    hosts: readLiveVoiceHostAvailability(),
  });
}

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

import {
  forgetAmbientLiveVoiceWatch,
  forgetAmbientLiveVoiceWatchesForCall,
  getAmbientLiveVoiceWatch,
  getAmbientLiveVoiceWatchHostsForCall,
  trackAmbientLiveVoiceWatch,
} from "@/live-voice/live-voice-work-registry";

interface AmbientWatchHostClient {
  setLiveVoiceAgentWatch(input: { enabled: boolean }): Promise<{ enabled: boolean }>;
}

interface AmbientWatchPin {
  client: AmbientWatchHostClient;
  release(): void;
}

export interface LiveVoiceAmbientWatchDeps {
  getSavedHosts(): readonly { serverId: string }[];
  /** `features.liveVoiceAmbientAgentReports` decides whether a host can do this. */
  supportsAmbientReports(serverId: string): boolean;
  pinActiveConnection(serverId: string): AmbientWatchPin | null;
}

export interface EnableAmbientLiveVoiceWatchesParams {
  sourceServerId: string;
  liveSessionId: string;
  deps: LiveVoiceAmbientWatchDeps;
  onError?: (serverId: string, error: unknown) => void;
}

/**
 * Turns on the ambient agent watch for every host this app can reach, including
 * the one hosting the call.
 *
 * A host that refuses, is offline, or is too old is skipped rather than failing
 * the call: the user asked for a conversation, not for a guarantee that every
 * machine is reporting. Hosts are registered before the request goes out so a
 * report that races the acknowledgement still resolves to this call.
 *
 * Returns the hosts now watching, for the caller to log or show.
 */
export async function enableAmbientLiveVoiceWatches(
  params: EnableAmbientLiveVoiceWatchesParams,
): Promise<string[]> {
  const { sourceServerId, liveSessionId, deps } = params;
  const results = await Promise.all(
    deps.getSavedHosts().map(async ({ serverId }) => {
      if (!deps.supportsAmbientReports(serverId)) {
        return null;
      }
      const pin = deps.pinActiveConnection(serverId);
      if (!pin) {
        return null;
      }
      trackAmbientLiveVoiceWatch({ targetServerId: serverId, sourceServerId, liveSessionId });
      try {
        const result = await pin.client.setLiveVoiceAgentWatch({ enabled: true });
        return result.enabled ? serverId : null;
      } catch (error) {
        params.onError?.(serverId, error);
        return null;
      } finally {
        pin.release();
      }
    }),
  );
  const enabled = results.filter((serverId): serverId is string => serverId !== null);
  // Registering optimistically means a host that then refused would still be
  // trusted to report, so drop the ones that did not take.
  for (const { serverId } of deps.getSavedHosts()) {
    if (!enabled.includes(serverId)) {
      forgetAmbientWatchForHost(serverId, liveSessionId);
    }
  }
  return enabled;
}

/**
 * Best-effort teardown. The daemon drops the watch when the socket goes anyway,
 * so a failure here costs nothing beyond a watch that outlives the call on a
 * host that is no longer registered to report into it.
 *
 * Only hosts registered for *this* call are told to stop. Teardown is not
 * awaited by the runtime, so a stop and the next start can overlap; disabling
 * by "every host we can see" would let the old call's teardown land after the
 * new call's setup and silence it.
 */
export async function disableAmbientLiveVoiceWatches(params: {
  liveSessionId: string;
  deps: LiveVoiceAmbientWatchDeps;
}): Promise<void> {
  const hosts = getAmbientLiveVoiceWatchHostsForCall(params.liveSessionId);
  forgetAmbientLiveVoiceWatchesForCall(params.liveSessionId);
  await Promise.all(
    hosts.map(async (serverId) => {
      const pin = params.deps.pinActiveConnection(serverId);
      if (!pin) {
        return;
      }
      try {
        await pin.client.setLiveVoiceAgentWatch({ enabled: false });
      } catch {
        // The socket is the real lifetime; nothing to recover here.
      } finally {
        pin.release();
      }
    }),
  );
}

/** Scoped by call so an entry belonging to a later call is never dropped here. */
function forgetAmbientWatchForHost(serverId: string, liveSessionId: string): void {
  if (getAmbientLiveVoiceWatch(serverId)?.liveSessionId === liveSessionId) {
    forgetAmbientLiveVoiceWatch(serverId);
  }
}

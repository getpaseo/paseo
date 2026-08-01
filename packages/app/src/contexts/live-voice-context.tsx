import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  createDefaultLiveVoiceRuntimeDeps,
  createLiveVoiceRuntime,
  type LiveVoiceDaemonClient,
  type LiveVoiceRuntime,
  type LiveVoiceSnapshot,
} from "@/live-voice/live-voice-runtime";
import type { LiveVoiceSessionMode } from "@/live-voice/live-voice-session";
import { registerLiveVoiceRouteAuthority } from "@/live-voice/live-voice-route-authority";
import { attachLiveVoiceCues } from "@/live-voice/live-voice-cues";
import { attachLiveVoiceCallNotification } from "@/live-voice/live-voice-call-notification";
import {
  disableAmbientLiveVoiceWatches,
  enableAmbientLiveVoiceWatches,
  type LiveVoiceAmbientWatchDeps,
} from "@/live-voice/live-voice-ambient-watch";
import { getLiveVoiceAmbientSettings } from "@/stores/live-voice-settings-store";

/**
 * Every host the app holds a connection to, read on demand. A call can outlive
 * any individual host connection, so nothing here is captured at start.
 */
const ambientWatchDeps: LiveVoiceAmbientWatchDeps = {
  getSavedHosts: () => getHostRuntimeStore().getHosts(),
  supportsAmbientReports: (serverId) =>
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.liveVoiceAmbientAgentReports === true,
  pinActiveConnection: (serverId) => getHostRuntimeStore().pinActiveConnection(serverId),
};

interface LiveVoiceContextValue extends LiveVoiceSnapshot {
  start: (serverId: string, sessionMode?: LiveVoiceSessionMode) => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  resumeAudio: () => Promise<void>;
  dismiss: () => void;
  isActiveForServer: (serverId: string) => boolean;
}

const EMPTY_SNAPSHOT: LiveVoiceSnapshot = {
  phase: "idle",
  serverId: null,
  liveSessionId: null,
  sessionMode: null,
  isMuted: false,
  isAudioBlocked: false,
  transcripts: [],
  error: null,
  closedCause: null,
};

const LiveVoiceRuntimeContext = createContext<LiveVoiceRuntime | null>(null);

const noopSubscribe = () => () => {};
const getEmptySnapshot = () => EMPTY_SNAPSHOT;

function asLiveVoiceDaemonClient(client: DaemonClient): LiveVoiceDaemonClient {
  return {
    startLiveVoice: (input) => client.startLiveVoice(input),
    stopLiveVoice: (input) => client.stopLiveVoice(input),
    subscribeUpdates: (handler) => client.on("voice.live.update", handler),
  };
}

/**
 * The runtime object itself, not a snapshot of it.
 *
 * For consumers that subscribe on their own rather than re-rendering — the Wear
 * bridge is the one that exists today. The identity is stable for the provider's
 * lifetime, so an effect can depend on it without re-running.
 */
export function useLiveVoiceRuntimeOptional(): LiveVoiceRuntime | null {
  return useContext(LiveVoiceRuntimeContext);
}

export function useLiveVoiceOptional(): LiveVoiceContextValue | null {
  const runtime = useContext(LiveVoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribe : noopSubscribe,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
  );

  // Runtime methods close over factory-local state and never use `this`, so they
  // are stable for the runtime's lifetime; memoising on [snapshot, runtime] keeps
  // the returned object reference stable across unrelated re-renders.
  return useMemo(() => {
    if (!runtime) {
      return null;
    }
    return {
      ...snapshot,
      start: runtime.start,
      stop: runtime.stop,
      toggleMute: runtime.toggleMute,
      resumeAudio: runtime.resumeAudio,
      dismiss: runtime.dismiss,
      isActiveForServer: runtime.isActiveForServer,
    };
  }, [snapshot, runtime]);
}

interface LiveVoiceProviderProps {
  children: ReactNode;
}

export function LiveVoiceProvider({ children }: LiveVoiceProviderProps) {
  const runtimeRef = useRef<LiveVoiceRuntime | null>(null);

  if (!runtimeRef.current) {
    runtimeRef.current = createLiveVoiceRuntime(
      createDefaultLiveVoiceRuntimeDeps(
        (serverId) => {
          // Read through the store on demand: the client is replaced on reconnect,
          // and the runtime should always negotiate over the current one.
          const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
          return client ? asLiveVoiceDaemonClient(client) : null;
        },
        (serverId) => {
          const pin = getHostRuntimeStore().pinActiveConnection(serverId);
          if (!pin) {
            return null;
          }
          return {
            client: asLiveVoiceDaemonClient(pin.client),
            release: pin.release,
          };
        },
        {
          read: getLiveVoiceAmbientSettings,
          enable: async ({ sourceServerId, liveSessionId }) => {
            await enableAmbientLiveVoiceWatches({
              sourceServerId,
              liveSessionId,
              deps: ambientWatchDeps,
              onError: (serverId, error) => {
                console.warn("[LiveVoice] Could not watch agents on host", {
                  serverId,
                  error: error instanceof Error ? error.message : String(error),
                });
              },
            });
          },
          disable: ({ liveSessionId }) =>
            disableAmbientLiveVoiceWatches({ liveSessionId, deps: ambientWatchDeps }),
        },
      ),
    );
  }

  const runtime = runtimeRef.current;

  useEffect(() => registerLiveVoiceRouteAuthority(runtime), [runtime]);

  // Declared before the destroy effect below so React detaches the cues first:
  // tearing the provider down ends the call, and that end is not a transition
  // the user should hear.
  useEffect(() => attachLiveVoiceCues(runtime), [runtime]);

  // Same ordering argument: detaching before the destroy effect stops the
  // notification's buttons from reaching a runtime that is being torn down.
  useEffect(() => attachLiveVoiceCallNotification(runtime), [runtime]);

  // A background call's native WebRTC path can remain healthy while Android
  // suspends the daemon control socket. Keep the exact pinned client through its
  // own reconnect loop; only a replacement client means this runtime can no
  // longer address the daemon-owned half of the call.
  useEffect(() => {
    let watchedServerId: string | null = null;
    let watchedClient: DaemonClient | null = null;

    const sync = (): void => {
      const snapshot = runtime.getSnapshot();
      // Only a live call is worth watching; an idle runtime owns no microphone.
      const activeServerId = snapshot.phase === "idle" ? null : snapshot.serverId;
      const client = activeServerId
        ? (useSessionStore.getState().sessions[activeServerId]?.client ?? null)
        : null;

      if (activeServerId === watchedServerId && client === watchedClient) {
        return;
      }

      // Same host, different client: the host reconnected and swapped the client
      // out from under our call. The new one is healthy, but ours is gone.
      const replacedFor =
        watchedServerId !== null && activeServerId === watchedServerId ? watchedServerId : null;

      watchedServerId = activeServerId;
      watchedClient = client;

      if (replacedFor !== null) {
        runtime.handleConnectionLost(replacedFor);
        return;
      }
    };

    const unsubscribeStore = useSessionStore.subscribe(sync);
    const unsubscribeRuntime = runtime.subscribe(sync);
    sync();
    return () => {
      unsubscribeStore();
      unsubscribeRuntime();
    };
  }, [runtime]);

  useEffect(() => {
    return () => {
      void runtime.destroy().catch((error) => {
        console.error("[LiveVoiceProvider] Failed to destroy live voice runtime", error);
      });
    };
  }, [runtime]);

  return (
    <LiveVoiceRuntimeContext.Provider value={runtime}>{children}</LiveVoiceRuntimeContext.Provider>
  );
}

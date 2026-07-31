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
      ),
    );
  }

  const runtime = runtimeRef.current;

  useEffect(() => registerLiveVoiceRouteAuthority(runtime), [runtime]);

  // A Live Voice call holds the microphone and an open peer connection, so losing
  // the daemon connection has to tear it down locally. Two distinct losses: the
  // socket reporting anything other than `connected`, and the host replacing the
  // client on reconnect (a fresh client is "connected", but our call died with
  // the old one and the daemon has already released it).
  useEffect(() => {
    let unsubscribeStatus: (() => void) | null = null;
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

      unsubscribeStatus?.();
      unsubscribeStatus = null;
      watchedServerId = activeServerId;
      watchedClient = client;

      if (replacedFor !== null) {
        runtime.handleConnectionLost(replacedFor);
        return;
      }
      if (!activeServerId || !client) {
        return;
      }
      unsubscribeStatus = client.subscribeConnectionStatus((state) => {
        if (state.status !== "connected") {
          runtime.handleConnectionLost(activeServerId);
        }
      });
    };

    const unsubscribeStore = useSessionStore.subscribe(sync);
    const unsubscribeRuntime = runtime.subscribe(sync);
    sync();
    return () => {
      unsubscribeStore();
      unsubscribeRuntime();
      unsubscribeStatus?.();
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

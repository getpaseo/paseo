import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSessionStore } from "@/stores/session-store";
import {
  createDefaultLiveVoiceRuntimeDeps,
  createLiveVoiceRuntime,
  type LiveVoiceRuntime,
  type LiveVoiceSnapshot,
} from "@/live-voice/live-voice-runtime";

interface LiveVoiceContextValue extends LiveVoiceSnapshot {
  start: (serverId: string, agentId: string) => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  resumeAudio: () => Promise<void>;
  isActiveForAgent: (serverId: string, agentId: string) => boolean;
}

const EMPTY_SNAPSHOT: LiveVoiceSnapshot = {
  phase: "idle",
  serverId: null,
  agentId: null,
  liveSessionId: null,
  isMuted: false,
  isAudioBlocked: false,
  transcripts: [],
  error: null,
  closedCause: null,
};

const LiveVoiceRuntimeContext = createContext<LiveVoiceRuntime | null>(null);

const noopSubscribe = () => () => {};
const getEmptySnapshot = () => EMPTY_SNAPSHOT;

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
      isActiveForAgent: runtime.isActiveForAgent,
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
      createDefaultLiveVoiceRuntimeDeps((serverId) => {
        // Read through the store on demand: the client is replaced on reconnect,
        // and the runtime should always negotiate over the current one.
        const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
        if (!client) {
          return null;
        }
        return {
          startLiveVoice: (input) => client.startLiveVoice(input),
          stopLiveVoice: (input) => client.stopLiveVoice(input),
          subscribeUpdates: (handler) => client.on("voice.live.update", handler),
        };
      }),
    );
  }

  const runtime = runtimeRef.current;

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

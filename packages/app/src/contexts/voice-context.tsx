import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { VoiceAppContext } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { createAudioEngine } from "@/voice/audio-engine";
import type { AudioEngine } from "@/voice/audio-engine-types";
import {
  createVoiceRuntime,
  type VoiceRuntime,
  type VoiceRuntimeSnapshot,
  type VoiceRuntimeTelemetrySnapshot,
} from "@/voice-chat/runtime";
import {
  createDaemonAudioTransportFactory,
  type DaemonAudioTransportFactory,
} from "@/voice-chat/transports/daemon-audio";

interface VoiceContextValue extends VoiceRuntimeSnapshot {
  startCall: (serverId: string, context: VoiceAppContext) => Promise<void>;
  stopVoice: () => Promise<void>;
  updateCallContext: (context: VoiceAppContext) => Promise<void>;
  dismissTranscript: () => void;
  isCallActiveOnServer: (serverId: string) => boolean;
  toggleMute: () => void;
}

const EMPTY_SNAPSHOT: VoiceRuntimeSnapshot = {
  phase: "disabled",
  isVoiceMode: false,
  isVoiceSwitching: false,
  isMuted: false,
  activeServerId: null,
  activeCallId: null,
  events: [],
};

const EMPTY_TELEMETRY: VoiceRuntimeTelemetrySnapshot = {
  volume: 0,
  isSpeaking: false,
  segmentDuration: 0,
};

const VoiceRuntimeContext = createContext<VoiceRuntime | null>(null);
const VoiceAudioEngineContext = createContext<AudioEngine | null>(null);

const noopSubscribe = () => () => {};
const getEmptySnapshot = () => EMPTY_SNAPSHOT;
const getEmptyTelemetry = () => EMPTY_TELEMETRY;

export function useVoice() {
  const value = useVoiceOptional();
  if (!value) {
    throw new Error("useVoice must be used within VoiceProvider");
  }
  return value;
}

export function useVoiceOptional(): VoiceContextValue | null {
  const runtime = useContext(VoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribe : noopSubscribe,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
  );

  // Methods on the runtime object literal close over factory-local state; they
  // don't use `this`, so no binding is needed. Memoising on [snapshot, runtime]
  // keeps the returned object reference stable across re-renders that don't
  // change either, preventing downstream memo/useMemo misses.
  return useMemo(() => {
    if (!runtime) {
      return null;
    }
    return {
      ...snapshot,
      startCall: runtime.startCall,
      stopVoice: runtime.stopVoice,
      updateCallContext: runtime.updateCallContext,
      dismissTranscript: runtime.dismissTranscript,
      isCallActiveOnServer: runtime.isCallActiveOnServer,
      toggleMute: runtime.toggleMute,
    };
  }, [snapshot, runtime]);
}

export function useVoiceTelemetry() {
  const telemetry = useVoiceTelemetryOptional();
  if (!telemetry) {
    throw new Error("useVoiceTelemetry must be used within VoiceProvider");
  }
  return telemetry;
}

export function useVoiceTelemetryOptional(): VoiceRuntimeTelemetrySnapshot | null {
  const runtime = useContext(VoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribeTelemetry.bind(runtime) : noopSubscribe,
    runtime ? runtime.getTelemetrySnapshot.bind(runtime) : getEmptyTelemetry,
    runtime ? runtime.getTelemetrySnapshot.bind(runtime) : getEmptyTelemetry,
  );

  return runtime ? snapshot : null;
}

export function useVoiceRuntimeOptional(): VoiceRuntime | null {
  return useContext(VoiceRuntimeContext);
}

export function useVoiceAudioEngineOptional(): AudioEngine | null {
  return useContext(VoiceAudioEngineContext);
}

interface VoiceProviderProps {
  children: ReactNode;
}

export function VoiceProvider({ children }: VoiceProviderProps) {
  const toast = useToast();
  const engineRef = useRef<AudioEngine | null>(null);
  const runtimeRef = useRef<VoiceRuntime | null>(null);

  if (!engineRef.current) {
    let runtime: VoiceRuntime | null = null;
    let daemonAudio: DaemonAudioTransportFactory | null = null;
    const reportMediaError = (error: unknown) => {
      const message = error instanceof Error ? error.message : "Voice media failed";
      toast.error(message);
      void runtime?.reportError(message);
    };
    const engine = createAudioEngine({
      onCaptureData: (pcm) => {
        daemonAudio?.handleCapturePcm(pcm);
      },
      onVolumeLevel: (level) => {
        daemonAudio?.handleCaptureVolume(level);
      },
      onInterruption: () => {
        void runtime?.stopVoice().catch((error) => {
          console.error("[VoiceEngine] Failed to stop after audio interruption:", error);
        });
      },
      onError: (error) => {
        reportMediaError(error);
      },
    });
    daemonAudio = createDaemonAudioTransportFactory({ engine, onError: reportMediaError });

    runtime = createVoiceRuntime({
      transports: [daemonAudio],
      getServerInfo: (serverId) =>
        useSessionStore.getState().getSession(serverId)?.serverInfo ?? null,
      activateKeepAwake: async (tag) => {
        await activateKeepAwakeAsync(tag);
      },
      deactivateKeepAwake: async (tag) => {
        await deactivateKeepAwake(tag);
      },
    });

    engineRef.current = engine;
    runtimeRef.current = runtime;
  }

  const engine = engineRef.current;
  const runtime = runtimeRef.current!;

  useEffect(() => {
    return () => {
      void runtime
        .destroy()
        .then(() => engine.destroy())
        .catch((error) => {
          console.error("[VoiceProvider] Failed to destroy voice runtime", error);
        });
    };
  }, [engine, runtime]);

  return (
    <VoiceAudioEngineContext.Provider value={engine}>
      <VoiceRuntimeContext.Provider value={runtime}>{children}</VoiceRuntimeContext.Provider>
    </VoiceAudioEngineContext.Provider>
  );
}

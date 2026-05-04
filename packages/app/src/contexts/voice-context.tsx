import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSessionStore } from "@/stores/session-store";
import { createAudioEngine } from "@/voice/audio-engine";
import type { AudioEngine } from "@/voice/audio-engine-types";
import {
  createVoiceRuntime,
  type VoiceRuntime,
  type VoiceRuntimeSnapshot,
  type VoiceRuntimeTelemetrySnapshot,
} from "@/voice/voice-runtime";

interface VoiceContextValue extends VoiceRuntimeSnapshot {
  startVoice: (serverId: string, agentId: string) => Promise<void>;
  stopVoice: () => Promise<void>;
  isVoiceModeForAgent: (serverId: string, agentId: string) => boolean;
  toggleMute: () => void;
}

const EMPTY_SNAPSHOT: VoiceRuntimeSnapshot = {
  phase: "disabled",
  isVoiceMode: false,
  isVoiceSwitching: false,
  isMuted: false,
  activeServerId: null,
  activeAgentId: null,
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
    runtime ? runtime.subscribe.bind(runtime) : noopSubscribe,
    runtime ? runtime.getSnapshot.bind(runtime) : getEmptySnapshot,
    runtime ? runtime.getSnapshot.bind(runtime) : getEmptySnapshot,
  );

  if (!runtime) {
    return null;
  }

  return {
    ...snapshot,
    startVoice: runtime.startVoice.bind(runtime),
    stopVoice: runtime.stopVoice.bind(runtime),
    isVoiceModeForAgent: runtime.isVoiceModeForAgent.bind(runtime),
    toggleMute: runtime.toggleMute.bind(runtime),
  };
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
  const engineRef = useRef<AudioEngine | null>(null);
  const runtimeRef = useRef<VoiceRuntime | null>(null);

  if (!engineRef.current) {
    let runtime: VoiceRuntime | null = null;
    const engine = createAudioEngine({
      onCaptureData: (pcm) => {
        runtime?.handleCapturePcm(pcm);
      },
      onVolumeLevel: (level) => {
        runtime?.handleCaptureVolume(level);
      },
      onError: (error) => {
        console.error("[VoiceEngine] Capture error:", error);
      },
    });

    runtime = createVoiceRuntime({
      engine,
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
      void runtime.destroy().catch((error) => {
        console.error("[VoiceProvider] Failed to destroy voice runtime", error);
      });
    };
  }, [runtime]);

  return (
    <VoiceAudioEngineContext.Provider value={engine}>
      <VoiceRuntimeContext.Provider value={runtime}>{children}</VoiceRuntimeContext.Provider>
    </VoiceAudioEngineContext.Provider>
  );
}

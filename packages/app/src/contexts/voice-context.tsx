import { createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef } from "react";
import { useSpeechmaticsAudio } from "@/hooks/use-speechmatics-audio";
import type { SessionState } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { REALTIME_VOICE_VAD_CONFIG } from "@/voice/realtime-voice-config";

const KEEP_AWAKE_TAG = "paseo:voice";
interface VoiceContextValue {
  isVoiceMode: boolean;
  isVoiceSwitching: boolean;
  volume: number;
  isMuted: boolean;
  isDetecting: boolean;
  isSpeaking: boolean;
  segmentDuration: number;
  startVoice: (serverId: string, agentId: string) => Promise<void>;
  stopVoice: () => Promise<void>;
  isVoiceModeForAgent: (serverId: string, agentId: string) => boolean;
  toggleMute: () => void;
  activeServerId: string | null;
  activeAgentId: string | null;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoice() {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error("useVoice must be used within VoiceProvider");
  }
  return context;
}

export function useVoiceOptional(): VoiceContextValue | null {
  return useContext(VoiceContext);
}

interface VoiceProviderProps {
  children: ReactNode;
}

export function VoiceProvider({ children }: VoiceProviderProps) {
  const getSession = useSessionStore((state) => state.getSession);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const { client: runtimeClient, isConnected: activeRuntimeConnected } = useHostRuntimeSession(
    activeServerId ?? ""
  );
  const activeSession = useSessionStore(
    useCallback(
      (state: ReturnType<typeof useSessionStore.getState>) => {
        if (!activeServerId) {
          return null;
        }
        return state.sessions[activeServerId] ?? null;
      },
      [activeServerId]
    )
  );
  const realtimeSessionRef = useRef<SessionState | null>(null);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isVoiceSwitching, setIsVoiceSwitching] = useState(false);
  const bargeInPlaybackStopRef = useRef<number | null>(null);
  const wasVoiceSocketConnectedRef = useRef(false);
  const lastVoiceModeSyncedClientRef = useRef<SessionState["client"] | null>(null);
  const voiceTransportReadyRef = useRef(false);
  const voiceResyncInFlightRef = useRef(false);
  const silenceGraceStartMsRef = useRef<number | null>(null);
  const speechInterruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechInterruptStartMsRef = useRef<number | null>(null);
  const speechStartInterruptSentRef = useRef(false);
  const isVoiceModeRef = useRef(false);
  const vadStateRef = useRef<{ isDetecting: boolean; isSpeaking: boolean }>({
    isDetecting: false,
    isSpeaking: false,
  });

  const clearSpeechStartInterruptTimer = useCallback((reason: string) => {
    const timer = speechInterruptTimerRef.current;
    if (timer) {
      clearTimeout(timer);
      speechInterruptTimerRef.current = null;
      const startedAt = speechInterruptStartMsRef.current;
      speechInterruptStartMsRef.current = null;
      if (startedAt !== null) {
        console.log("[Voice] Cleared speech-start interrupt timer", {
          reason,
          elapsedMs: Date.now() - startedAt,
        });
      } else {
        console.log("[Voice] Cleared speech-start interrupt timer", { reason });
      }
      return;
    }
    speechInterruptStartMsRef.current = null;
  }, []);

  const interruptActiveVoiceTurn = useCallback((source: string) => {
    const session = realtimeSessionRef.current;
    const sessionAudioPlayer = session?.audioPlayer ?? null;
    const sessionClient = session?.client ?? null;
    const sessionIsPlayingAudio = session?.isPlayingAudio ?? false;

    if (sessionIsPlayingAudio && sessionAudioPlayer) {
      if (bargeInPlaybackStopRef.current === null) {
        bargeInPlaybackStopRef.current = Date.now();
      }
      sessionAudioPlayer.stop();
    }

    try {
      if (sessionClient) {
        void sessionClient.abortRequest().catch((error) => {
          console.error("[Voice] Failed to send abort_request:", error);
        });
      }
      console.log("[Voice] Sent abort_request before streaming audio", { source });
    } catch (error) {
      console.error("[Voice] Failed to send abort_request:", error);
    }
  }, []);

  const realtimeAudio = useSpeechmaticsAudio({
    onSpeechStart: () => {
      console.log("[Voice] Segment started (speech confirmed)");
    },
    onSpeechEnd: () => {
      const silenceMs =
        silenceGraceStartMsRef.current === null
          ? null
          : Date.now() - silenceGraceStartMsRef.current;
      if (silenceMs === null) {
        console.log("[Voice] Segment finalized");
      } else {
        console.log("[Voice] Segment finalized", { silenceMs });
      }
      silenceGraceStartMsRef.current = null;
      clearSpeechStartInterruptTimer("speech ended");
      speechStartInterruptSentRef.current = false;
    },
    onAudioSegment: ({ audioData, isLast }) => {
      if (!voiceTransportReadyRef.current) {
        console.log("[Voice] Skipping audio segment: voice transport not ready");
        return;
      }
      console.log(
        "[Voice] Sending audio segment, length:",
        audioData.length,
        "isLast:",
        isLast
      );

      // Send audio segment to server (realtime always goes to orchestrator)
      const session = realtimeSessionRef.current;
      try {
        if (session?.client) {
          void session.client
            .sendVoiceAudioChunk(
              audioData,
              "audio/pcm;rate=16000;bits=16",
              isLast
            )
            .catch((error) => {
              console.error("[Voice] Failed to send audio segment:", error);
            });
        }
      } catch (error) {
        console.error("[Voice] Failed to send audio segment:", error);
      }
    },
    onError: (error) => {
      console.error("[Voice] Audio error:", error);
      const session = realtimeSessionRef.current;
      if (session?.client) {
        // Send error through websocket instead of directly manipulating messages
        console.error("[Voice] Cannot handle error - setMessages not available from SessionState");
      }
    },
    volumeThreshold: REALTIME_VOICE_VAD_CONFIG.volumeThreshold,
    confirmedDropGracePeriod: REALTIME_VOICE_VAD_CONFIG.confirmedDropGracePeriodMs,
    silenceDuration: REALTIME_VOICE_VAD_CONFIG.silenceDurationMs,
    speechConfirmationDuration: REALTIME_VOICE_VAD_CONFIG.speechConfirmationMs,
    detectionGracePeriod: REALTIME_VOICE_VAD_CONFIG.detectionGracePeriodMs,
  });

  useEffect(() => {
    realtimeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    isVoiceModeRef.current = isVoiceMode;
  }, [isVoiceMode]);

  useEffect(() => {
    if (!isVoiceMode) {
      clearSpeechStartInterruptTimer("voice mode disabled");
      speechStartInterruptSentRef.current = false;
      return;
    }

    if (realtimeAudio.isSpeaking) {
      if (
        speechStartInterruptSentRef.current ||
        speechInterruptTimerRef.current !== null
      ) {
        return;
      }
      speechInterruptStartMsRef.current = Date.now();
      speechInterruptTimerRef.current = setTimeout(() => {
        speechInterruptTimerRef.current = null;
        speechInterruptStartMsRef.current = null;
        if (
          !isVoiceModeRef.current ||
          !vadStateRef.current.isSpeaking ||
          speechStartInterruptSentRef.current
        ) {
          return;
        }
        speechStartInterruptSentRef.current = true;
        console.log("[Voice] Speech persisted beyond grace; interrupting turn", {
          graceMs: REALTIME_VOICE_VAD_CONFIG.interruptGracePeriodMs,
        });
        interruptActiveVoiceTurn("speech_start_grace_elapsed");
      }, REALTIME_VOICE_VAD_CONFIG.interruptGracePeriodMs);
      return;
    }

    clearSpeechStartInterruptTimer("speech stopped before grace");
  }, [
    clearSpeechStartInterruptTimer,
    interruptActiveVoiceTurn,
    isVoiceMode,
    realtimeAudio.isSpeaking,
  ]);

  useEffect(() => {
    return () => {
      clearSpeechStartInterruptTimer("voice provider unmounted");
    };
  }, [clearSpeechStartInterruptTimer]);

  useEffect(() => {
    const next = {
      isDetecting: realtimeAudio.isDetecting,
      isSpeaking: realtimeAudio.isSpeaking,
    };
    const prev = vadStateRef.current;

    if (!isVoiceMode) {
      silenceGraceStartMsRef.current = null;
      vadStateRef.current = next;
      return;
    }

    // Confirmed speech dropped below threshold: grace window starts.
    if (prev.isSpeaking && !next.isSpeaking && next.isDetecting) {
      silenceGraceStartMsRef.current = Date.now();
      console.log("[Voice] Grace started (speech dropped below threshold)");
    }

    // User resumed speaking before grace timeout elapsed.
    if (!prev.isSpeaking && next.isSpeaking && silenceGraceStartMsRef.current !== null) {
      const resumedAfterMs = Date.now() - silenceGraceStartMsRef.current;
      console.log("[Voice] Speech resumed during grace", { resumedAfterMs });
      silenceGraceStartMsRef.current = null;
    }

    // Fully idle (neither detecting nor speaking).
    if (!next.isDetecting && !next.isSpeaking) {
      silenceGraceStartMsRef.current = null;
      speechStartInterruptSentRef.current = false;
    }

    vadStateRef.current = next;
  }, [isVoiceMode, realtimeAudio.isDetecting, realtimeAudio.isSpeaking]);

  useEffect(() => {
    const connected = activeRuntimeConnected;
    const client = runtimeClient;
    if (!connected) {
      voiceTransportReadyRef.current = false;
    }

    if (!isVoiceMode || !activeServerId || !activeAgentId || !client) {
      wasVoiceSocketConnectedRef.current = connected;
      if (!isVoiceMode) {
        lastVoiceModeSyncedClientRef.current = null;
      }
      voiceTransportReadyRef.current = false;
      return;
    }

    const connectionRecovered = connected && !wasVoiceSocketConnectedRef.current;
    const clientChanged = lastVoiceModeSyncedClientRef.current !== client;
    if (connected && (connectionRecovered || clientChanged)) {
      if (!voiceResyncInFlightRef.current) {
        voiceResyncInFlightRef.current = true;
        voiceTransportReadyRef.current = false;
        setIsVoiceSwitching(true);
        void client.setVoiceMode(true, activeAgentId).then(
          () => {
            console.log("[Voice] Re-synced voice mode after reconnect");
            lastVoiceModeSyncedClientRef.current = client;
            voiceTransportReadyRef.current = true;
          },
          (error) => {
            console.error("[Voice] Failed to re-sync voice mode:", error);
          }
        ).finally(() => {
          voiceResyncInFlightRef.current = false;
          setIsVoiceSwitching(false);
        });
      }
    }

    wasVoiceSocketConnectedRef.current = connected;
  }, [activeAgentId, activeRuntimeConnected, activeServerId, isVoiceMode, runtimeClient]);

  const isPlayingAudio = activeSession?.isPlayingAudio ?? false;

  useEffect(() => {
    if (!isPlayingAudio && bargeInPlaybackStopRef.current !== null) {
      const latencyMs = Date.now() - bargeInPlaybackStopRef.current;
      console.log("[Telemetry] barge_in.playback_stop_latency", {
        latencyMs,
        startedAt: new Date(bargeInPlaybackStopRef.current).toISOString(),
        completedAt: new Date().toISOString(),
      });
      bargeInPlaybackStopRef.current = null;
    }
  }, [isPlayingAudio]);

  const startVoice = useCallback(
    async (serverId: string, agentId: string) => {
      const session = getSession(serverId) ?? null;
      if (!session) {
        throw new Error(`Host ${serverId} is not connected`);
      }
      const unavailableMessage = resolveVoiceUnavailableMessage({
        serverInfo: session.serverInfo,
        mode: "voice",
      });
      if (unavailableMessage) {
        throw new Error(unavailableMessage);
      }

      setIsVoiceSwitching(true);
      voiceTransportReadyRef.current = false;
      try {
        const previousSession = realtimeSessionRef.current;
        if (
          isVoiceMode &&
          previousSession?.client &&
          (activeServerId !== serverId || activeAgentId !== agentId)
        ) {
          await previousSession.client.setVoiceMode(false);
        }

        realtimeSessionRef.current = session;
        setActiveServerId(serverId);
        setActiveAgentId(agentId);
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch((error) => {
          console.warn("[Voice] Failed to activate keep-awake:", error);
        });
        if (session?.client) {
          await session.client.setVoiceMode(true, agentId);
        } else {
          console.warn("[Voice] setVoiceMode skipped: daemon unavailable");
        }
        await session.audioPlayer?.warmup?.();
        await realtimeAudio.start();
        voiceTransportReadyRef.current = true;
        setIsVoiceMode(true);
        lastVoiceModeSyncedClientRef.current = session.client;
        console.log("[Voice] Mode enabled");
      } catch (error: any) {
        console.error("[Voice] Failed to start:", error);
        await realtimeAudio.stop().catch(() => undefined);
        setActiveServerId((current) => (current === serverId ? null : current));
        setActiveAgentId((current) => (current === agentId ? null : current));
        await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
        throw error;
      } finally {
        setIsVoiceSwitching(false);
      }
    },
    [activeAgentId, activeServerId, getSession, isVoiceMode, realtimeAudio]
  );

  const stopVoice = useCallback(async () => {
    setIsVoiceSwitching(true);
    voiceTransportReadyRef.current = false;
    try {
      const session = realtimeSessionRef.current;
      session?.audioPlayer?.stop();
      if (session?.client) {
        await session.client.setVoiceMode(false);
        lastVoiceModeSyncedClientRef.current = session.client;
      } else {
        console.warn("[Voice] setVoiceMode skipped: daemon unavailable");
      }
      await realtimeAudio.stop();
      setIsVoiceMode(false);
      setActiveServerId(null);
      setActiveAgentId(null);
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      console.log("[Voice] Mode disabled");
    } catch (error: any) {
      console.error("[Voice] Failed to stop:", error);
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      throw error;
    } finally {
      setIsVoiceSwitching(false);
    }
  }, [realtimeAudio]);

  const isVoiceModeForAgent = useCallback(
    (serverId: string, agentId: string) =>
      isVoiceMode && activeServerId === serverId && activeAgentId === agentId,
    [activeAgentId, activeServerId, isVoiceMode]
  );

  const value: VoiceContextValue = {
    isVoiceMode,
    isVoiceSwitching,
    volume: realtimeAudio.volume,
    isMuted: realtimeAudio.isMuted,
    isDetecting: realtimeAudio.isDetecting,
    isSpeaking: realtimeAudio.isSpeaking,
    segmentDuration: realtimeAudio.segmentDuration,
    startVoice,
    stopVoice,
    isVoiceModeForAgent,
    toggleMute: realtimeAudio.toggleMute,
    activeServerId,
    activeAgentId,
  };

  return (
    <VoiceContext.Provider value={value}>
      {children}
    </VoiceContext.Provider>
  );
}

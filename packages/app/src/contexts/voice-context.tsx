import { createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef } from "react";
import { useSpeechmaticsAudio } from "@/hooks/use-speechmatics-audio";
import type { SessionState } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";

const VOICE_CONVERSATION_ID_STORAGE_KEY = "@paseo:voice-conversation-id";

interface VoiceContextValue {
  isVoiceMode: boolean;
  volume: number;
  isMuted: boolean;
  isDetecting: boolean;
  isSpeaking: boolean;
  segmentDuration: number;
  startVoice: (serverId: string) => Promise<void>;
  stopVoice: () => Promise<void>;
  toggleMute: () => void;
  activeServerId: string | null;
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
  const bargeInPlaybackStopRef = useRef<number | null>(null);

  const realtimeAudio = useSpeechmaticsAudio({
    onSpeechStart: () => {
      console.log("[Voice] Speech detected");
      // Stop audio playback if playing
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

      // Abort any in-flight orchestrator turn before the new speech segment streams
      try {
        if (sessionClient) {
          void sessionClient.abortRequest().catch((error) => {
            console.error("[Voice] Failed to send abort_request:", error);
          });
        }
        console.log("[Voice] Sent abort_request before streaming audio");
      } catch (error) {
        console.error("[Voice] Failed to send abort_request:", error);
      }
    },
    onSpeechEnd: () => {
      console.log("[Voice] Speech ended");
    },
    onAudioSegment: ({ audioData, isLast }) => {
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
    volumeThreshold: 0.3,
    silenceDuration: 2000,
    speechConfirmationDuration: 300,
    detectionGracePeriod: 200,
  });

  useEffect(() => {
    realtimeSessionRef.current = activeSession;
  }, [activeSession]);

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
    async (serverId: string) => {
      const session = getSession(serverId) ?? null;
      if (!session) {
        throw new Error(`Host ${serverId} is not connected`);
      }

      try {
        realtimeSessionRef.current = session;
        setActiveServerId(serverId);
        await session.audioPlayer?.warmup?.();
        await realtimeAudio.start();
        setIsVoiceMode(true);
        console.log("[Voice] Mode enabled");

        if (session?.client) {
          let voiceConversationId =
            (await AsyncStorage.getItem(VOICE_CONVERSATION_ID_STORAGE_KEY)) ?? null;
          if (!voiceConversationId) {
            voiceConversationId = randomUUID();
            await AsyncStorage.setItem(
              VOICE_CONVERSATION_ID_STORAGE_KEY,
              voiceConversationId
            );
          }
          await session.client.setVoiceConversation(true, voiceConversationId);
        } else {
          console.warn("[Voice] setVoiceConversation skipped: daemon unavailable");
        }
      } catch (error: any) {
        console.error("[Voice] Failed to start:", error);
        setActiveServerId((current) => (current === serverId ? null : current));
        throw error;
      }
    },
    [getSession, realtimeAudio]
  );

  const stopVoice = useCallback(async () => {
    try {
      const session = realtimeSessionRef.current;
      session?.audioPlayer?.stop();
      await realtimeAudio.stop();
      setIsVoiceMode(false);
      setActiveServerId(null);
      console.log("[Voice] Mode disabled");

      if (session?.client) {
        await session.client.setVoiceConversation(false);
      } else {
        console.warn("[Voice] setVoiceConversation skipped: daemon unavailable");
      }
    } catch (error: any) {
      console.error("[Voice] Failed to stop:", error);
      throw error;
    }
  }, [realtimeAudio]);

  const value: VoiceContextValue = {
    isVoiceMode,
    volume: realtimeAudio.volume,
    isMuted: realtimeAudio.isMuted,
    isDetecting: realtimeAudio.isDetecting,
    isSpeaking: realtimeAudio.isSpeaking,
    segmentDuration: realtimeAudio.segmentDuration,
    startVoice,
    stopVoice,
    toggleMute: realtimeAudio.toggleMute,
    activeServerId,
  };

  return (
    <VoiceContext.Provider value={value}>
      {children}
    </VoiceContext.Provider>
  );
}

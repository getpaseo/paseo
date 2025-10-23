import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { useSpeechmaticsAudio } from "@/hooks/use-speechmatics-audio";
import { useSession } from "./session-context";
import { generateMessageId } from "@/types/stream";
import type { WSInboundMessage } from "@server/server/messages";

interface RealtimeContextValue {
  isRealtimeMode: boolean;
  volume: number;
  isMuted: boolean;
  isDetecting: boolean;
  isSpeaking: boolean;
  segmentDuration: number;
  startRealtime: () => Promise<void>;
  stopRealtime: () => Promise<void>;
  toggleMute: () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error("useRealtime must be used within RealtimeProvider");
  }
  return context;
}

interface RealtimeProviderProps {
  children: ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const { ws, audioPlayer, isPlayingAudio, setMessages } = useSession();
  const [isRealtimeMode, setIsRealtimeMode] = useState(false);

  const realtimeAudio = useSpeechmaticsAudio({
    onSpeechStart: () => {
      console.log("[Realtime] Speech detected");
      // Stop audio playback if playing
      if (isPlayingAudio) {
        audioPlayer.stop();
      }
    },
    onSpeechEnd: () => {
      console.log("[Realtime] Speech ended");
    },
    onAudioSegment: (base64Audio: string) => {
      console.log("[Realtime] Sending audio segment, length:", base64Audio.length);

      // Send audio segment to server (realtime always goes to orchestrator)
      try {
        ws.send({
          type: "session",
          message: {
            type: "realtime_audio_chunk",
            audio: base64Audio,
            format: "audio/wav",
            isLast: true, // Complete segment
          },
        });
      } catch (error) {
        console.error("[Realtime] Failed to send audio segment:", error);
      }
    },
    onError: (error) => {
      console.error("[Realtime] Audio error:", error);
      setMessages((prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType: "error",
          message: `Realtime audio error: ${error.message}`,
        },
      ]);
    },
    volumeThreshold: 0.3,
    silenceDuration: 2000,
    speechConfirmationDuration: 300,
    detectionGracePeriod: 200,
  });

  const startRealtime = useCallback(async () => {
    try {
      await realtimeAudio.start();
      setIsRealtimeMode(true);
      console.log("[Realtime] Mode enabled");

      // Notify server
      const modeMessage: WSInboundMessage = {
        type: "session",
        message: {
          type: "set_realtime_mode",
          enabled: true,
        },
      };
      ws.send(modeMessage);
    } catch (error: any) {
      console.error("[Realtime] Failed to start:", error);
      throw error;
    }
  }, [realtimeAudio, ws]);

  const stopRealtime = useCallback(async () => {
    try {
      await realtimeAudio.stop();
      setIsRealtimeMode(false);
      console.log("[Realtime] Mode disabled");

      // Notify server
      const modeMessage: WSInboundMessage = {
        type: "session",
        message: {
          type: "set_realtime_mode",
          enabled: false,
        },
      };
      ws.send(modeMessage);
    } catch (error: any) {
      console.error("[Realtime] Failed to stop:", error);
      throw error;
    }
  }, [realtimeAudio, ws]);

  const value: RealtimeContextValue = {
    isRealtimeMode,
    volume: realtimeAudio.volume,
    isMuted: realtimeAudio.isMuted,
    isDetecting: realtimeAudio.isDetecting,
    isSpeaking: realtimeAudio.isSpeaking,
    segmentDuration: realtimeAudio.segmentDuration,
    startRealtime,
    stopRealtime,
    toggleMute: realtimeAudio.toggleMute,
  };

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

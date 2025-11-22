import { useCallback, useMemo, useState } from "react";

export interface SpeechmaticsAudioConfig {
  onAudioSegment?: (segment: { audioData: string; isLast: boolean }) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  volumeThreshold: number;
  silenceDuration: number;
  speechConfirmationDuration: number;
  detectionGracePeriod: number;
}

export interface SpeechmaticsAudio {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  isActive: boolean;
  isSpeaking: boolean;
  isDetecting: boolean;
  isMuted: boolean;
  volume: number;
  segmentDuration: number;
}

/**
 * Web shim for the Speechmatics two-way audio hook.
 * Real-time microphone capture is currently unsupported on web.
 */
export function useSpeechmaticsAudio(
  _config: SpeechmaticsAudioConfig
): SpeechmaticsAudio {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const start = useCallback(async () => {
    console.warn("[SpeechmaticsAudio] Web microphone capture disabled");
    setIsActive(true);
  }, []);

  const stop = useCallback(async () => {
    setIsActive(false);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  return useMemo(
    () => ({
      start,
      stop,
      toggleMute,
      isActive,
      isSpeaking: false,
      isDetecting: false,
      isMuted,
      volume: 0,
      segmentDuration: 0,
    }),
    [start, stop, toggleMute, isActive, isMuted]
  );
}

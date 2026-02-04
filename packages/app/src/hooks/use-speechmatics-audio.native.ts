import { useState, useEffect, useRef, useCallback } from "react";
import {
  initialize,
  useMicrophonePermissions,
  toggleRecording,
  tearDown,
  useExpoTwoWayAudioEventListener,
  type MicrophoneDataCallback,
  type VolumeLevelCallback,
} from "@boudra/expo-two-way-audio";

import { SpeechSegmenter } from "@/voice/speech-segmenter";

export interface SpeechmaticsAudioConfig {
  onAudioSegment?: (segment: { audioData: string; isLast: boolean }) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  /** When true, stream microphone PCM continuously without VAD gating. */
  enableContinuousStreaming?: boolean;
  volumeThreshold: number; // Volume threshold for speech detection (0-1)
  silenceDuration: number; // ms of silence before ending segment
  speechConfirmationDuration: number; // ms of sustained speech before confirming
  detectionGracePeriod: number; // ms grace period for volume dips during detection
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
 * Hook for audio capture with echo cancellation using Speechmatics expo-two-way-audio
 */
export function useSpeechmaticsAudio(
  config: SpeechmaticsAudioConfig
): SpeechmaticsAudio {
  const [microphonePermission, requestMicrophonePermission] =
    useMicrophonePermissions();
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const [volume, setVolume] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [segmentDuration, setSegmentDuration] = useState(0);

  const enableContinuousStreaming = config.enableContinuousStreaming === true;

  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const callbacksRef = useRef({
    onAudioSegment: config.onAudioSegment,
    onSpeechStart: config.onSpeechStart,
    onSpeechEnd: config.onSpeechEnd,
  });
  useEffect(() => {
    callbacksRef.current = {
      onAudioSegment: config.onAudioSegment,
      onSpeechStart: config.onSpeechStart,
      onSpeechEnd: config.onSpeechEnd,
    };
  }, [config.onAudioSegment, config.onSpeechStart, config.onSpeechEnd]);

  const segmenterRef = useRef<SpeechSegmenter | null>(null);
  if (segmenterRef.current === null) {
    segmenterRef.current = new SpeechSegmenter(
      {
        enableContinuousStreaming,
        volumeThreshold: config.volumeThreshold,
        silenceDurationMs: config.silenceDuration,
        speechConfirmationMs: config.speechConfirmationDuration,
        detectionGracePeriodMs: config.detectionGracePeriod,
      },
      {
        onAudioSegment: (segment) => callbacksRef.current.onAudioSegment?.(segment),
        onSpeechStart: () => callbacksRef.current.onSpeechStart?.(),
        onSpeechEnd: () => callbacksRef.current.onSpeechEnd?.(),
        onDetectingChange: (next) => setIsDetecting(next),
        onSpeakingChange: (next) => setIsSpeaking(next),
      }
    );
  }

  useEffect(() => {
    segmenterRef.current?.updateConfig({
      enableContinuousStreaming,
      volumeThreshold: config.volumeThreshold,
      silenceDurationMs: config.silenceDuration,
      speechConfirmationMs: config.speechConfirmationDuration,
      detectionGracePeriodMs: config.detectionGracePeriod,
    });
  }, [
    enableContinuousStreaming,
    config.volumeThreshold,
    config.silenceDuration,
    config.speechConfirmationDuration,
    config.detectionGracePeriod,
  ]);

  // Update segment duration timer
  useEffect(() => {
    if (!isDetecting && !isSpeaking) {
      setSegmentDuration(0);
      return;
    }

    const startTime = segmenterRef.current?.getSpeechDetectionStartMs() ?? Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setSegmentDuration(elapsed);
    }, 100);

    return () => clearInterval(interval);
  }, [isDetecting, isSpeaking]);

  // Listen to microphone data
  useExpoTwoWayAudioEventListener(
    "onMicrophoneData",
    useCallback<MicrophoneDataCallback>(
      (event) => {
        if (!isActiveRef.current || isMutedRef.current) return;

        const pcmData: Uint8Array = event.data;
        segmenterRef.current?.pushPcmChunk(pcmData);
      },
      []
    )
  );

  // Listen to volume level for VAD
  useExpoTwoWayAudioEventListener(
    "onInputVolumeLevelData",
    useCallback<VolumeLevelCallback>(
      (event) => {
        if (!isActiveRef.current) return;

        const volumeLevel: number = event.data;
        setVolume(volumeLevel);

        if (isMutedRef.current) return;
        segmenterRef.current?.pushVolumeLevel(volumeLevel, Date.now());
      },
      []
    )
  );

  const ensureMicrophonePermission = useCallback(async () => {
    let permissionStatus = microphonePermission;

    if (!permissionStatus?.granted) {
      try {
        permissionStatus = await requestMicrophonePermission();
      } catch (err) {
        throw new Error("Failed to request microphone permission");
      }
    }

    if (!permissionStatus?.granted) {
      throw new Error(
        "Microphone permission is required to capture audio. Please enable microphone access in system settings."
      );
    }
  }, [microphonePermission, requestMicrophonePermission]);

  async function start(): Promise<void> {
    if (isActive) {
      console.log("[SpeechmaticsAudio] Already active");
      return;
    }

    try {
      await ensureMicrophonePermission();

      // Initialize audio if not already initialized
      if (!audioInitialized) {
        console.log("[SpeechmaticsAudio] Initializing audio...");
        await initialize();
        setAudioInitialized(true);
        console.log("[SpeechmaticsAudio] Audio initialized");
      }

      console.log("[SpeechmaticsAudio] Starting audio capture...");

      // Start recording
      toggleRecording(true);

      setIsActive(true);
      console.log("[SpeechmaticsAudio] Audio capture started successfully");
    } catch (error) {
      console.error("[SpeechmaticsAudio] Start error:", error);
      const err = error instanceof Error ? error : new Error(String(error));
      config.onError?.(err);
      await stop();
      throw error;
    }
  }

  async function stop(): Promise<void> {
    console.log("[SpeechmaticsAudio] Stopping audio capture...");

    // Stop recording
    if (isActive) {
      toggleRecording(false);
    }

    segmenterRef.current?.stop(Date.now());

    // Tear down audio session
    if (audioInitialized) {
      tearDown();
      setAudioInitialized(false);
      console.log("[SpeechmaticsAudio] Audio torn down");
    }

    // Reset state
    segmenterRef.current?.reset();
    setIsActive(false);
    setIsSpeaking(false);
    setIsDetecting(false);
    setVolume(0);
    setIsMuted(false);

    console.log("[SpeechmaticsAudio] Audio capture stopped");
  }

  function toggleMute(): void {
    setIsMuted((prev) => {
      const newMuted = !prev;
      console.log("[SpeechmaticsAudio] Mute toggled:", newMuted);

      if (newMuted) {
        // Clear any ongoing speech detection/speaking state
        segmenterRef.current?.reset();
        setIsSpeaking(false);
        setIsDetecting(false);
      }

      return newMuted;
    });
  }

  return {
    start,
    stop,
    toggleMute,
    isActive,
    isSpeaking,
    isDetecting,
    isMuted,
    volume,
    segmentDuration,
  };
}

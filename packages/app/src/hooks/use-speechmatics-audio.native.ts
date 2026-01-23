import { useState, useEffect, useRef, useCallback } from "react";
import { Buffer } from "buffer";
import {
  initialize,
  useMicrophonePermissions,
  toggleRecording,
  tearDown,
  useExpoTwoWayAudioEventListener,
  type MicrophoneDataCallback,
  type VolumeLevelCallback,
} from "@boudra/expo-two-way-audio";

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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // NOTE: This is performance-sensitive during continuous streaming.
  // Buffer-backed base64 is significantly faster than manual string building.
  try {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  } catch {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

function concatenateUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
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

  const audioBufferRef = useRef<Uint8Array[]>([]);
  const silenceStartRef = useRef<number | null>(null);
  const isSpeakingRef = useRef(false);
  const speechDetectionStartRef = useRef<number | null>(null);
  const speechConfirmedRef = useRef(false);
  const detectionSilenceStartRef = useRef<number | null>(null);
  const bufferedBytesRef = useRef(0);

  const PCM_SAMPLE_RATE = 16000;
  const PCM_CHANNELS = 1;
  const PCM_BITS_PER_SAMPLE = 16;
  const PCM_BYTES_PER_MS =
    (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) / 1000;
  const MIN_CHUNK_DURATION_MS = 1000;
  const MIN_CHUNK_BYTES = Math.round(
    PCM_BYTES_PER_MS * MIN_CHUNK_DURATION_MS
  );

  const flushBufferedAudio = useCallback(
    (isLast: boolean) => {
      if (audioBufferRef.current.length === 0) {
        bufferedBytesRef.current = 0;
        return;
      }

      const combinedBinary = concatenateUint8Arrays(audioBufferRef.current);
      const pcmBase64 = uint8ArrayToBase64(combinedBinary);

      config.onAudioSegment?.({
        audioData: pcmBase64,
        isLast,
      });

      audioBufferRef.current = [];
      bufferedBytesRef.current = 0;
    },
    [config]
  );

  const VOLUME_THRESHOLD = config.volumeThreshold;
  const SILENCE_DURATION_MS = config.silenceDuration;
  const SPEECH_CONFIRMATION_MS = config.speechConfirmationDuration;
  const DETECTION_GRACE_PERIOD_MS = config.detectionGracePeriod;

  // Update segment duration timer
  useEffect(() => {
    if (!isDetecting && !isSpeaking) {
      setSegmentDuration(0);
      return;
    }

    const startTime = speechDetectionStartRef.current || Date.now();
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
        if (!isActive || isMuted) return;

        const pcmData: Uint8Array = event.data;

        if (enableContinuousStreaming) {
          audioBufferRef.current.push(pcmData);
          bufferedBytesRef.current += pcmData.length;
          if (bufferedBytesRef.current >= MIN_CHUNK_BYTES) {
            flushBufferedAudio(false);
          }
          return;
        }

        // Buffer the audio chunk if we're detecting or speaking
        // Start buffering from first spike to capture beginning of speech
        if (speechDetectionStartRef.current !== null || isSpeakingRef.current) {
          audioBufferRef.current.push(pcmData);
          bufferedBytesRef.current += pcmData.length;

          if (
            speechConfirmedRef.current &&
            bufferedBytesRef.current >= MIN_CHUNK_BYTES
          ) {
            flushBufferedAudio(false);
          }
        }
      },
      [enableContinuousStreaming, isActive, isMuted, flushBufferedAudio, MIN_CHUNK_BYTES]
    )
  );

  // Listen to volume level for VAD
  useExpoTwoWayAudioEventListener(
    "onInputVolumeLevelData",
    useCallback<VolumeLevelCallback>(
      (event) => {
        if (!isActive) return;

        const volumeLevel: number = event.data;
        setVolume(volumeLevel);

        if (isMuted) return;
        if (enableContinuousStreaming) return;

        const speechDetected = volumeLevel > VOLUME_THRESHOLD;

        // console.log('[SpeechmaticsAudio] Volume:', volumeLevel.toFixed(6), 'Threshold:', VOLUME_THRESHOLD);

        if (
          speechDetected &&
          !isSpeakingRef.current &&
          !speechConfirmedRef.current
        ) {
          // Initial speech detection - start tracking
          if (speechDetectionStartRef.current === null) {
            console.log(
              "[SpeechmaticsAudio] Speech started (volume:",
              volumeLevel.toFixed(4),
              ")"
            );
            speechDetectionStartRef.current = Date.now();
            detectionSilenceStartRef.current = null;
            audioBufferRef.current = [];
            bufferedBytesRef.current = 0;
            setIsDetecting(true);
          } else {
            // Volume is back above threshold - reset grace period
            detectionSilenceStartRef.current = null;

            // Check if speech has been sustained long enough
            const speechDuration = Date.now() - speechDetectionStartRef.current;
            if (speechDuration >= SPEECH_CONFIRMATION_MS) {
              // Speech CONFIRMED
              console.log(
                "[SpeechmaticsAudio] Speech confirmed after",
                speechDuration,
                "ms"
              );
              isSpeakingRef.current = true;
              speechConfirmedRef.current = true;
              silenceStartRef.current = null;
              setIsDetecting(false);
              setIsSpeaking(true);
              config.onSpeechStart?.();
            }
          }
        } else if (
          speechDetected &&
          isSpeakingRef.current &&
          speechConfirmedRef.current
        ) {
          // Continuing confirmed speech
          silenceStartRef.current = null;
        } else if (
          !speechDetected &&
          !speechConfirmedRef.current &&
          speechDetectionStartRef.current !== null
        ) {
          // Volume dropped during detection phase - apply grace period
          if (detectionSilenceStartRef.current === null) {
            detectionSilenceStartRef.current = Date.now();
          } else {
            const graceDuration = Date.now() - detectionSilenceStartRef.current;
            if (graceDuration >= DETECTION_GRACE_PERIOD_MS) {
              // Grace period expired - cancel detection
              console.log(
                "[SpeechmaticsAudio] Speech detection cancelled after",
                graceDuration,
                "ms grace period"
              );
              speechDetectionStartRef.current = null;
              detectionSilenceStartRef.current = null;
              audioBufferRef.current = [];
              bufferedBytesRef.current = 0;
              setIsDetecting(false);
            }
          }
        } else if (
          !speechDetected &&
          isSpeakingRef.current &&
          speechConfirmedRef.current
        ) {
          // Potential speech END
          if (silenceStartRef.current === null) {
            silenceStartRef.current = Date.now();
          } else {
            const silenceDuration = Date.now() - silenceStartRef.current;
            if (silenceDuration >= SILENCE_DURATION_MS) {
              // Speech END confirmed
              console.log(
                "[SpeechmaticsAudio] Speech ended after",
                silenceDuration,
                "ms silence"
              );
              isSpeakingRef.current = false;
              speechConfirmedRef.current = false;
              speechDetectionStartRef.current = null;
              silenceStartRef.current = null;
              setIsSpeaking(false);
              config.onSpeechEnd?.();

              // Send buffered audio segment
              flushBufferedAudio(true);
            }
          }
        }
      },
      [
        enableContinuousStreaming,
        isActive,
        isMuted,
        VOLUME_THRESHOLD,
        SILENCE_DURATION_MS,
        SPEECH_CONFIRMATION_MS,
        DETECTION_GRACE_PERIOD_MS,
        config,
        flushBufferedAudio,
      ]
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

    if (enableContinuousStreaming) {
      flushBufferedAudio(true);
    }

    // Tear down audio session
    if (audioInitialized) {
      tearDown();
      setAudioInitialized(false);
      console.log("[SpeechmaticsAudio] Audio torn down");
    }

    // Reset state
    audioBufferRef.current = [];
    bufferedBytesRef.current = 0;
    isSpeakingRef.current = false;
    speechConfirmedRef.current = false;
    speechDetectionStartRef.current = null;
    detectionSilenceStartRef.current = null;
    silenceStartRef.current = null;
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
        audioBufferRef.current = [];
        bufferedBytesRef.current = 0;
        isSpeakingRef.current = false;
        speechConfirmedRef.current = false;
        speechDetectionStartRef.current = null;
        detectionSilenceStartRef.current = null;
        silenceStartRef.current = null;
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

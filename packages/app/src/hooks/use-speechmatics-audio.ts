import { useState, useEffect, useRef, useCallback } from "react";
import {
  initialize,
  toggleRecording,
  tearDown,
  useExpoTwoWayAudioEventListener,
  type MicrophoneDataCallback,
  type VolumeLevelCallback,
} from "@speechmatics/expo-two-way-audio";

export interface SpeechmaticsAudioConfig {
  onAudioSegment?: (audioData: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
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
 * Convert raw PCM data to WAV format by adding WAV headers
 */
function pcmToWav(
  pcmBase64: string,
  sampleRate: number = 16000,
  channels: number = 1,
  bitsPerSample: number = 16
): string {
  const pcmBinary = atob(pcmBase64);
  const pcmLength = pcmBinary.length;

  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmLength;
  const fileSize = 44 + dataSize;

  const wavBuffer = new Uint8Array(fileSize);
  const view = new DataView(wavBuffer.buffer);

  let offset = 0;

  // RIFF chunk descriptor
  writeString(view, offset, "RIFF");
  offset += 4;
  view.setUint32(offset, fileSize - 8, true);
  offset += 4;
  writeString(view, offset, "WAVE");
  offset += 4;

  // fmt sub-chunk
  writeString(view, offset, "fmt ");
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bitsPerSample, true);
  offset += 2;

  // data sub-chunk
  writeString(view, offset, "data");
  offset += 4;
  view.setUint32(offset, dataSize, true);
  offset += 4;

  // Copy PCM data
  for (let i = 0; i < pcmLength; i++) {
    wavBuffer[offset + i] = pcmBinary.charCodeAt(i);
  }

  // Convert to base64
  let binary = "";
  for (let i = 0; i < wavBuffer.length; i++) {
    binary += String.fromCharCode(wavBuffer[i]);
  }
  return btoa(binary);
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const [volume, setVolume] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [segmentDuration, setSegmentDuration] = useState(0);

  const audioBufferRef = useRef<Uint8Array[]>([]);
  const silenceStartRef = useRef<number | null>(null);
  const isSpeakingRef = useRef(false);
  const speechDetectionStartRef = useRef<number | null>(null);
  const speechConfirmedRef = useRef(false);
  const detectionSilenceStartRef = useRef<number | null>(null);

  const VOLUME_THRESHOLD = config.volumeThreshold;
  const SILENCE_DURATION_MS = config.silenceDuration;
  const SPEECH_CONFIRMATION_MS = config.speechConfirmationDuration;
  const DETECTION_GRACE_PERIOD_MS = config.detectionGracePeriod;

  // Initialize audio on mount
  useEffect(() => {
    const initializeAudio = async () => {
      try {
        await initialize();
        setAudioInitialized(true);
        console.log("[SpeechmaticsAudio] Audio initialized");
      } catch (error) {
        console.error("[SpeechmaticsAudio] Initialization error:", error);
        const err = error instanceof Error ? error : new Error(String(error));
        config.onError?.(err);
      }
    };
    initializeAudio();

    return () => {
      tearDown();
    };
  }, []);

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

        // Buffer the audio chunk if we're detecting or speaking
        // Start buffering from first spike to capture beginning of speech
        if (speechDetectionStartRef.current !== null || isSpeakingRef.current) {
          audioBufferRef.current.push(pcmData);
        }
      },
      [isActive, isMuted]
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

        const speechDetected = volumeLevel > VOLUME_THRESHOLD;

        // console.log('[SpeechmaticsAudio] Volume:', volumeLevel.toFixed(6), 'Threshold:', VOLUME_THRESHOLD);

        if (speechDetected && !isSpeakingRef.current && !speechConfirmedRef.current) {
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
        } else if (speechDetected && isSpeakingRef.current && speechConfirmedRef.current) {
          // Continuing confirmed speech
          silenceStartRef.current = null;
        } else if (!speechDetected && !speechConfirmedRef.current && speechDetectionStartRef.current !== null) {
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
              setIsDetecting(false);
            }
          }
        } else if (!speechDetected && isSpeakingRef.current && speechConfirmedRef.current) {
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
              if (audioBufferRef.current.length > 0) {
                const combinedBinary = concatenateUint8Arrays(
                  audioBufferRef.current
                );
                const combinedPcmBase64 = uint8ArrayToBase64(combinedBinary);
                const wavAudio = pcmToWav(combinedPcmBase64, 16000, 1, 16);
                config.onAudioSegment?.(wavAudio);
                audioBufferRef.current = [];
              }
            }
          }
        }
      },
      [isActive, isMuted, VOLUME_THRESHOLD, SILENCE_DURATION_MS, SPEECH_CONFIRMATION_MS, DETECTION_GRACE_PERIOD_MS, config]
    )
  );

  async function start(): Promise<void> {
    if (!audioInitialized) {
      throw new Error("Audio not initialized");
    }

    if (isActive) {
      console.log("[SpeechmaticsAudio] Already active");
      return;
    }

    try {
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
    toggleRecording(false);

    // Reset state
    audioBufferRef.current = [];
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isActive) {
        stop();
      }
    };
  }, [isActive]);

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

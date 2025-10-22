import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useAudioRecorder } from '@siteed/expo-audio-studio';
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions';

export interface RealtimeAudioConfig {
  onAudioSegment?: (audioData: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  volumeThreshold?: number; // RMS threshold for speech detection (0-1)
  silenceDuration?: number; // ms of silence before ending segment
  speechStartDuration?: number; // ms of sustained volume before starting segment
}

export interface RealtimeAudio {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isActive: boolean;
  isSpeaking: boolean;
}

/**
 * Convert raw PCM data to WAV format by adding WAV headers
 * @param pcmBase64 Base64-encoded PCM data
 * @param sampleRate Sample rate (default: 16000)
 * @param channels Number of channels (default: 1 for mono)
 * @param bitsPerSample Bits per sample (default: 16)
 * @returns Base64-encoded WAV data
 */
function pcmToWav(
  pcmBase64: string,
  sampleRate: number = 16000,
  channels: number = 1,
  bitsPerSample: number = 16
): string {
  // Decode base64 PCM data
  const pcmBinary = atob(pcmBase64);
  const pcmLength = pcmBinary.length;

  // Calculate WAV parameters
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmLength;
  const fileSize = 44 + dataSize; // WAV header is 44 bytes

  // Create WAV buffer
  const wavBuffer = new Uint8Array(fileSize);
  const view = new DataView(wavBuffer.buffer);

  // Write WAV header
  let offset = 0;

  // RIFF chunk descriptor
  writeString(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, fileSize - 8, true); offset += 4; // File size - 8
  writeString(view, offset, 'WAVE'); offset += 4;

  // fmt sub-chunk
  writeString(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4; // Subchunk size (16 for PCM)
  view.setUint16(offset, 1, true); offset += 2; // Audio format (1 = PCM)
  view.setUint16(offset, channels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bitsPerSample, true); offset += 2;

  // data sub-chunk
  writeString(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;

  // Copy PCM data
  for (let i = 0; i < pcmLength; i++) {
    wavBuffer[offset + i] = pcmBinary.charCodeAt(i);
  }

  // Convert to base64
  let binary = '';
  for (let i = 0; i < wavBuffer.length; i++) {
    binary += String.fromCharCode(wavBuffer[i]);
  }
  return btoa(binary);
}

/**
 * Helper to write string to DataView
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Decode base64 string to Uint8Array
 */
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Concatenate multiple Uint8Arrays into one
 */
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
 * Hook for realtime audio streaming with volume-based VAD
 * Uses expo-audio-studio for recording with echo cancellation and noise suppression
 */
export function useRealtimeAudio(config: RealtimeAudioConfig): RealtimeAudio {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const audioRecorder = useAudioRecorder();
  const audioBufferRef = useRef<Uint8Array[]>([]);
  const silenceStartRef = useRef<number | null>(null);
  const isSpeakingRef = useRef(false);
  const speechStartRef = useRef<number | null>(null); // Track when volume first exceeded threshold
  const speechConfirmedRef = useRef(false); // Track if speech has been confirmed
  const lastVolumeCheckRef = useRef<number>(Date.now());
  const lastVolumeLogRef = useRef<number>(Date.now());

  const VOLUME_THRESHOLD = config.volumeThreshold ?? 0.2;
  const SILENCE_DURATION_MS = config.silenceDuration ?? 1000;
  const SPEECH_START_DURATION_MS = config.speechStartDuration ?? 1000;
  const VOLUME_CHECK_INTERVAL = 200; // Check volume every 200ms

  async function requestMicrophonePermission(): Promise<boolean> {
    try {
      const permission = Platform.OS === 'ios'
        ? PERMISSIONS.IOS.MICROPHONE
        : PERMISSIONS.ANDROID.RECORD_AUDIO;

      const status = await check(permission);
      if (status === RESULTS.GRANTED) {
        return true;
      }

      const result = await request(permission);
      return result === RESULTS.GRANTED;
    } catch (error) {
      console.error('[RealtimeAudio] Permission error:', error);
      return false;
    }
  }

  function calculateVolume(base64Audio: string): number {
    try {
      // Decode base64 to binary
      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Calculate RMS from PCM data (16-bit signed PCM, little-endian)
      let sum = 0;
      const sampleCount = Math.floor(bytes.length / 2);

      for (let i = 0; i < bytes.length - 1; i += 2) {
        // Read 16-bit value as unsigned first
        let sample = bytes[i] | (bytes[i + 1] << 8);

        // Convert to signed 16-bit (two's complement)
        if (sample > 32767) {
          sample -= 65536;
        }

        // Normalize to -1.0 to 1.0 range
        const normalized = sample / 32768.0;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / sampleCount);
      return rms;
    } catch (error) {
      console.error('[RealtimeAudio] Volume calculation error:', error);
      return 0;
    }
  }

  async function start(): Promise<void> {
    if (isActive) {
      console.log('[RealtimeAudio] Already active');
      return;
    }

    try {
      console.log('[RealtimeAudio] Starting realtime audio...');

      // Request permissions
      const hasPermission = await requestMicrophonePermission();
      if (!hasPermission) {
        throw new Error('Microphone permission denied');
      }

      // Start recording with audio streaming
      await audioRecorder.startRecording({
        sampleRate: 16000,
        channels: 1,
        encoding: 'pcm_16bit',
        interval: 100, // Get chunks every 100ms
        onAudioStream: async (event: any) => {
          if (!event.data) return;

          const audioData = event.data; // base64 PCM data

          // Check volume periodically
          const now = Date.now();
          if (now - lastVolumeCheckRef.current >= VOLUME_CHECK_INTERVAL) {
            lastVolumeCheckRef.current = now;

            const volume = calculateVolume(audioData);
            const speechDetected = volume > VOLUME_THRESHOLD;

            // Decode base64 chunk to binary for buffering
            const decodedChunk = decodeBase64ToUint8Array(audioData);

            // Check if we're in detection phase (volume detected but not yet confirmed)
            const inDetectionPhase = speechStartRef.current !== null && !isSpeakingRef.current;

            if (inDetectionPhase) {
              // We're in detection phase - check timer regardless of current volume
              const sustainedDuration = Date.now() - speechStartRef.current!;

              if (sustainedDuration >= SPEECH_START_DURATION_MS) {
                // Timer elapsed - confirm speech
                console.log('[RealtimeAudio] ✅ Speech confirmed after', sustainedDuration, 'ms (volume:', volume.toFixed(4), 'threshold:', VOLUME_THRESHOLD, ')');
                isSpeakingRef.current = true;
                speechConfirmedRef.current = true;
                setIsSpeaking(true);
                config.onSpeechStart?.();
                audioBufferRef.current.push(decodedChunk);
                silenceStartRef.current = null;
              } else if (speechDetected) {
                // Still in detection phase, volume still above threshold, keep buffering
                audioBufferRef.current.push(decodedChunk);

                // Log progress every 500ms during detection
                const logNow = Date.now();
                if (logNow - lastVolumeLogRef.current >= 500) {
                  console.log('[RealtimeAudio] 🔍 Detecting...', sustainedDuration, '/', SPEECH_START_DURATION_MS, 'ms (volume:', volume.toFixed(4), ')');
                  lastVolumeLogRef.current = logNow;
                }
              } else {
                // Volume dropped before timer elapsed - false start
                console.log('[RealtimeAudio] ❌ False start (volume dropped after', sustainedDuration, 'ms, needed', SPEECH_START_DURATION_MS, 'ms)');
                speechStartRef.current = null;
                speechConfirmedRef.current = false;
                audioBufferRef.current = [];
              }
            } else if (speechDetected && !isSpeakingRef.current) {
              // First volume detection - start timer and buffering
              console.log('[RealtimeAudio] 🎤 Volume spike detected! Starting detection... (volume:', volume.toFixed(4), 'threshold:', VOLUME_THRESHOLD, ')');
              speechStartRef.current = Date.now();
              speechConfirmedRef.current = false;
              audioBufferRef.current = [decodedChunk];
              silenceStartRef.current = null;
            } else if (speechDetected && isSpeakingRef.current) {
              // Continuing confirmed speech - just buffer, no logs
              audioBufferRef.current.push(decodedChunk);
              silenceStartRef.current = null;
            } else if (!speechDetected && isSpeakingRef.current) {
              // Potential speech END (after confirmed speech)
              audioBufferRef.current.push(decodedChunk);

              if (silenceStartRef.current === null) {
                silenceStartRef.current = Date.now();
                console.log('[RealtimeAudio] 🔇 Silence detected, waiting', SILENCE_DURATION_MS, 'ms to confirm end...');
              } else {
                const silenceDuration = Date.now() - silenceStartRef.current;
                if (silenceDuration >= SILENCE_DURATION_MS) {
                  // Speech END confirmed
                  const totalChunks = audioBufferRef.current.length;
                  console.log('[RealtimeAudio] 🛑 Speech ended after', silenceDuration, 'ms silence (captured', totalChunks, 'chunks)');
                  isSpeakingRef.current = false;
                  speechStartRef.current = null;
                  speechConfirmedRef.current = false;
                  silenceStartRef.current = null;
                  setIsSpeaking(false);
                  config.onSpeechEnd?.();

                  // Send buffered audio segment
                  if (audioBufferRef.current.length > 0) {
                    // Concatenate all binary chunks
                    const combinedBinary = concatenateUint8Arrays(audioBufferRef.current);
                    const audioSizeKb = (combinedBinary.length / 1024).toFixed(2);
                    console.log('[RealtimeAudio] 📤 Sending audio segment:', audioSizeKb, 'KB');
                    // Convert to base64
                    const combinedPcmBase64 = uint8ArrayToBase64(combinedBinary);
                    // Convert PCM to WAV format
                    const wavAudio = pcmToWav(combinedPcmBase64, 16000, 1, 16);
                    config.onAudioSegment?.(wavAudio);
                    audioBufferRef.current = [];
                  }
                }
              }
            }
          } else if (isSpeakingRef.current) {
            // Just buffer if we're speaking but not checking volume yet
            const decodedChunk = decodeBase64ToUint8Array(audioData);
            audioBufferRef.current.push(decodedChunk);
          }
        },
      });

      setIsActive(true);
      console.log('[RealtimeAudio] 🎙️ Audio capture started (threshold:', VOLUME_THRESHOLD, 'duration:', SPEECH_START_DURATION_MS, 'ms)');
    } catch (error) {
      console.error('[RealtimeAudio] Start error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      config.onError?.(err);

      // Cleanup on error
      await stop();
      throw error;
    }
  }

  async function stop(): Promise<void> {
    console.log('[RealtimeAudio] Stopping realtime audio...');

    // Stop recording
    if (audioRecorder.isRecording) {
      try {
        await audioRecorder.stopRecording();
      } catch (error) {
        console.error('[RealtimeAudio] Error stopping recording:', error);
      }
    }

    // Reset state
    audioBufferRef.current = [];
    isSpeakingRef.current = false;
    speechStartRef.current = null;
    speechConfirmedRef.current = false;
    silenceStartRef.current = null;
    setIsActive(false);
    setIsSpeaking(false);

    console.log('[RealtimeAudio] Realtime audio stopped');
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isActive) {
        stop();
      }
    };
  }, []);

  return {
    start,
    stop,
    isActive,
    isSpeaking,
  };
}

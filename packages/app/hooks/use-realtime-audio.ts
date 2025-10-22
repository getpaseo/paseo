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
}

export interface RealtimeAudio {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isActive: boolean;
  isSpeaking: boolean;
}

/**
 * Hook for realtime audio streaming with volume-based VAD
 * Uses expo-audio-studio for recording with echo cancellation and noise suppression
 */
export function useRealtimeAudio(config: RealtimeAudioConfig): RealtimeAudio {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const audioRecorder = useAudioRecorder();
  const audioBufferRef = useRef<string[]>([]);
  const silenceStartRef = useRef<number | null>(null);
  const isSpeakingRef = useRef(false);
  const lastVolumeCheckRef = useRef<number>(Date.now());

  const VOLUME_THRESHOLD = config.volumeThreshold ?? 0.02;
  const SILENCE_DURATION_MS = config.silenceDuration ?? 1000;
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
      console.log('[RealtimeAudio] Volume:', rms.toFixed(6));
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

            if (speechDetected && !isSpeakingRef.current) {
              // Speech START
              console.log('[RealtimeAudio] Speech started (volume:', volume.toFixed(4), ')');
              isSpeakingRef.current = true;
              silenceStartRef.current = null;
              audioBufferRef.current = [audioData];
              setIsSpeaking(true);
              config.onSpeechStart?.();
            } else if (speechDetected && isSpeakingRef.current) {
              // Continuing speech
              audioBufferRef.current.push(audioData);
              silenceStartRef.current = null;
            } else if (!speechDetected && isSpeakingRef.current) {
              // Potential speech END
              audioBufferRef.current.push(audioData);

              if (silenceStartRef.current === null) {
                silenceStartRef.current = Date.now();
              } else {
                const silenceDuration = Date.now() - silenceStartRef.current;
                if (silenceDuration >= SILENCE_DURATION_MS) {
                  // Speech END confirmed
                  console.log('[RealtimeAudio] Speech ended after', silenceDuration, 'ms silence');
                  isSpeakingRef.current = false;
                  silenceStartRef.current = null;
                  setIsSpeaking(false);
                  config.onSpeechEnd?.();

                  // Send buffered audio segment
                  if (audioBufferRef.current.length > 0) {
                    const combinedAudio = audioBufferRef.current.join('');
                    config.onAudioSegment?.(combinedAudio);
                    audioBufferRef.current = [];
                  }
                }
              }
            }
          } else if (isSpeakingRef.current) {
            // Just buffer if we're speaking but not checking volume yet
            audioBufferRef.current.push(audioData);
          }
        },
      });

      setIsActive(true);
      console.log('[RealtimeAudio] Realtime audio started successfully');
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

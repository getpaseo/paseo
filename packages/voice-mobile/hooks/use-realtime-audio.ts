import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { createVADRNBridgeInstance } from 'react-native-vad';
import { AudioRecording } from '@siteed/expo-audio-studio';
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions';

export interface RealtimeAudioConfig {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onAudioSegment?: (audioData: string, format: string) => void;
  onError?: (error: Error) => void;
  speechThreshold?: number;
  silenceDuration?: number;
}

export interface RealtimeAudio {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isActive: boolean;
  isSpeechDetected: boolean;
}

/**
 * Hook for realtime audio with VAD-based segmentation
 * Uses react-native-vad for speech detection and expo-audio-studio for recording
 */
export function useRealtimeAudio(config: RealtimeAudioConfig): RealtimeAudio {
  const [isActive, setIsActive] = useState(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState(false);

  const vadInstanceRef = useRef<any>(null);
  const recordingRef = useRef<AudioRecording | null>(null);
  const audioBufferRef = useRef<string[]>([]);
  const vadPollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isSpeakingRef = useRef(false);
  const silenceStartRef = useRef<number | null>(null);

  const SPEECH_THRESHOLD = config.speechThreshold ?? 0.5;
  const SILENCE_DURATION_MS = config.silenceDuration ?? 1000; // 1 second of silence to end segment

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

  async function initializeVAD(): Promise<void> {
    try {
      console.log('[RealtimeAudio] Initializing VAD...');
      const instance = await createVADRNBridgeInstance('realtime-vad', false);
      if (!instance) {
        throw new Error('Failed to create VAD instance');
      }

      // Create VAD instance with sensitivity
      instance.createInstance(0.1, 10);

      // Set license (using the example license from the demo)
      await instance.setVADDetectionLicense(
        "MTczOTU3MDQwMDAwMA==-+2/cH2HBQz3/SsDidS6qvIgc8KxGH5cbvSVM/6qmk3Q="
      );

      // Start VAD detection
      await instance.startVADDetection();

      vadInstanceRef.current = instance;
      console.log('[RealtimeAudio] VAD initialized successfully');
    } catch (error) {
      console.error('[RealtimeAudio] VAD initialization error:', error);
      throw error;
    }
  }

  async function startAudioRecording(): Promise<void> {
    try {
      console.log('[RealtimeAudio] Starting audio recording...');

      const recording = new AudioRecording({
        sampleRate: 16000,
        channels: 1,
        encoding: 'pcm_16bit',
        interval: 500, // Get audio chunks every 500ms
      });

      // Handle audio stream chunks
      recording.onAudioStream = (event: any) => {
        // Only buffer chunks while speech is detected
        if (isSpeakingRef.current && event.data) {
          audioBufferRef.current.push(event.data);
          console.log('[RealtimeAudio] Buffered chunk, total chunks:', audioBufferRef.current.length);
        }
      };

      await recording.start();
      recordingRef.current = recording;
      console.log('[RealtimeAudio] Audio recording started');
    } catch (error) {
      console.error('[RealtimeAudio] Recording start error:', error);
      throw error;
    }
  }

  function startVADPolling(): void {
    console.log('[RealtimeAudio] Starting VAD polling...');

    vadPollingIntervalRef.current = setInterval(async () => {
      if (!vadInstanceRef.current) return;

      try {
        const voiceProps = await vadInstanceRef.current.getVoiceProps();
        const probability = voiceProps.voiceProbability;
        const speechDetected = probability > SPEECH_THRESHOLD;

        // Update UI state
        setIsSpeechDetected(speechDetected);

        // Handle speech start
        if (speechDetected && !isSpeakingRef.current) {
          console.log('[RealtimeAudio] Speech START detected (probability:', probability, ')');
          isSpeakingRef.current = true;
          silenceStartRef.current = null;
          audioBufferRef.current = []; // Start new buffer
          config.onSpeechStart?.();
        }
        // Handle potential speech end (silence detected)
        else if (!speechDetected && isSpeakingRef.current) {
          if (silenceStartRef.current === null) {
            // First silence detection - start timer
            silenceStartRef.current = Date.now();
          } else {
            // Check if silence duration threshold reached
            const silenceDuration = Date.now() - silenceStartRef.current;
            if (silenceDuration >= SILENCE_DURATION_MS) {
              console.log('[RealtimeAudio] Speech END detected (silence for', silenceDuration, 'ms)');
              isSpeakingRef.current = false;
              silenceStartRef.current = null;
              config.onSpeechEnd?.();

              // Send buffered audio segment
              if (audioBufferRef.current.length > 0) {
                const combinedAudio = combineAudioChunks(audioBufferRef.current);
                config.onAudioSegment?.(combinedAudio, 'audio/wav');
                audioBufferRef.current = [];
              }
            }
          }
        }
        // Reset silence timer if speech detected again
        else if (speechDetected && isSpeakingRef.current && silenceStartRef.current !== null) {
          silenceStartRef.current = null;
        }
      } catch (error) {
        console.error('[RealtimeAudio] VAD polling error:', error);
      }
    }, 200); // Poll every 200ms
  }

  function combineAudioChunks(chunks: string[]): string {
    // Combine base64 PCM chunks into a single audio segment
    // For now, just concatenate - you may need proper WAV header
    console.log('[RealtimeAudio] Combining', chunks.length, 'audio chunks');
    return chunks.join('');
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

      // Initialize VAD
      await initializeVAD();

      // Start audio recording
      await startAudioRecording();

      // Start VAD polling
      startVADPolling();

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

    // Stop VAD polling
    if (vadPollingIntervalRef.current) {
      clearInterval(vadPollingIntervalRef.current);
      vadPollingIntervalRef.current = null;
    }

    // Stop recording
    if (recordingRef.current) {
      try {
        await recordingRef.current.stop();
        recordingRef.current = null;
      } catch (error) {
        console.error('[RealtimeAudio] Error stopping recording:', error);
      }
    }

    // Stop VAD
    if (vadInstanceRef.current) {
      try {
        await vadInstanceRef.current.stopVADDetection();
        vadInstanceRef.current = null;
      } catch (error) {
        console.error('[RealtimeAudio] Error stopping VAD:', error);
      }
    }

    // Reset state
    audioBufferRef.current = [];
    isSpeakingRef.current = false;
    silenceStartRef.current = null;
    setIsActive(false);
    setIsSpeechDetected(false);

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
    isSpeechDetected,
  };
}

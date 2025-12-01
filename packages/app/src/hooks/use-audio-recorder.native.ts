import { useAudioRecorder as useExpoAudioRecorder, useAudioRecorderState, RecordingOptions, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { Paths, File, Directory, FileInfo } from 'expo-file-system';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';

export interface AudioCaptureConfig {
  sampleRate?: number;
  numberOfChannels?: number;
  bitRate?: number;
  onAudioLevel?: (level: number) => void;
  onSpeechSegment?: (audioBlob: Blob) => void;
  enableContinuousRecording?: boolean;
}

/**
 * Workaround for Expo SDK 54 Android bug where audioRecorder.uri returns empty/zero-byte file
 * https://github.com/expo/expo/issues/39646
 */
async function getActualRecordingUri(createdAt: Date): Promise<string | null> {
  try {
    console.log('[AudioRecorder] Searching for recording file created at:', createdAt.toISOString());

    const audioDir = new Directory(Paths.cache, 'Audio');
    console.log('[AudioRecorder] Audio cache directory URI:', audioDir.uri);
    console.log('[AudioRecorder] Directory exists:', audioDir.exists);

    if (!audioDir.exists) {
      console.log('[AudioRecorder] Audio cache directory does not exist');
      return null;
    }

    const files = audioDir.list();
    console.log('[AudioRecorder] Found files in Audio cache:', files.length);

    if (!files.length) {
      console.log('[AudioRecorder] No files found in Audio cache directory');
      return null;
    }

    const validFiles = files
      .map(file => {
        const info = file.info();
        console.log('[AudioRecorder] File info:', {
          uri: info.uri,
          size: info.size,
          creationTime: info.creationTime ? new Date(info.creationTime).toISOString() : null,
        });
        return info;
      })
      .filter(f => f.size && f.size > 0);

    console.log('[AudioRecorder] Valid files (size > 0):', validFiles.length);

    if (validFiles.length === 0) {
      console.log('[AudioRecorder] No valid files found (all are zero-byte)');
      return null;
    }

    let closest: FileInfo | null = null;
    let minDiff = Infinity;

    for (const file of validFiles) {
      if (!file.creationTime || !file.uri) continue;
      const diff = Math.abs(file.creationTime - createdAt.getTime());
      console.log('[AudioRecorder] Time diff for file:', {
        uri: file.uri,
        diffMs: diff,
      });
      if (diff < minDiff) {
        closest = file;
        minDiff = diff;
      }
    }

    if (closest) {
      const resultUri = closest.uri?.slice(0, -1) ?? null;
      console.log('[AudioRecorder] Found closest file:', {
        uri: resultUri,
        size: closest.size,
        timeDiffMs: minDiff,
      });
      return resultUri;
    }

    console.log('[AudioRecorder] No closest file found');
    return null;
  } catch (e) {
    console.error('[AudioRecorder] Error finding actual recording file:', e);
    return null;
  }
}

/**
 * Convert audio file URI to Blob for WebSocket transmission
 * Returns a Blob-like object that works in React Native
 */
async function uriToBlob(uri: string): Promise<Blob> {
  // Use expo-file-system to read the file
  const file = new File(uri);
  const base64 = await file.base64();
  const size = file.size;

  // React Native doesn't support creating Blobs from binary data
  // Create a Blob-like object that has the methods we need
  const blobLike = {
    type: 'audio/m4a',
    size: size,
    arrayBuffer: async () => {
      // Convert base64 to ArrayBuffer
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    },
  } as Blob;

  return blobLike;
}

/**
 * Hook for audio recording with configuration matching web version
 * Matches the web app's audio constraints:
 * - 16000 sample rate (optimal for speech/Whisper)
 * - 1 channel (mono)
 * - Echo cancellation, noise suppression, auto gain control (voice_communication on Android)
 */
export function useAudioRecorder(config?: AudioCaptureConfig) {
  const [recordingStartTime, setRecordingStartTime] = useState<Date | null>(null);
  const recordingIntentRef = useRef(false);
  const stopRequestedRef = useRef(false);

  // Store config callbacks in refs so they can update without recreating the recorder
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Create stable recording options - only recreate if actual config values change
  const recordingOptions: RecordingOptions = useMemo(() => ({
    ...RecordingPresets.HIGH_QUALITY,
    sampleRate: config?.sampleRate || 16000,
    numberOfChannels: config?.numberOfChannels || 1,
    bitRate: config?.bitRate || 128000,
    extension: '.m4a',
    isMeteringEnabled: !!config?.onAudioLevel, // Enable metering if callback provided
    android: {
      extension: '.m4a',
      outputFormat: 'mpeg4',
      audioEncoder: 'aac',
      sampleRate: config?.sampleRate || 16000,
      audioSource: 'voice_communication', // Enables echo cancellation, noise suppression, auto gain control
    },
    ios: {
      extension: '.m4a',
      audioQuality: 127, // High quality
      sampleRate: config?.sampleRate || 16000,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: {
      mimeType: 'audio/webm;codecs=opus',
      bitsPerSecond: config?.bitRate || 128000,
    },
  }), [config?.sampleRate, config?.numberOfChannels, config?.bitRate, config?.onAudioLevel]);

  const audioRecorder = useExpoAudioRecorder(recordingOptions);
  const recorderState = useAudioRecorderState(audioRecorder, 100);

  // Store recorder in ref for stable access across re-renders
  const recorderRef = useRef(audioRecorder);
  useEffect(() => {
    recorderRef.current = audioRecorder;
  }, [audioRecorder]);

  // Monitor audio levels if metering is enabled
  // Use configRef to access the latest callback without recreating the effect
  useEffect(() => {
    const currentConfig = configRef.current;
    if (!currentConfig?.onAudioLevel || !recorderState.isRecording) return;

    const interval = setInterval(() => {
      const metering = recorderState.metering;
      if (metering !== undefined && metering !== null) {
        // Normalize metering value (typically ranges from -160 to 0 dB)
        // Convert to 0-1 range where 0 is silence and 1 is loud
        // We'll use -40 dB as the threshold for "loud"
        const normalized = Math.max(0, Math.min(1, (metering + 40) / 40));
        configRef.current?.onAudioLevel?.(normalized);
      }
    }, 100); // Check every 100ms

    return () => clearInterval(interval);
  }, [recorderState.metering, recorderState.isRecording]);

  const start = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;

    // Use expo's isRecording as single source of truth
    if (recorder.isRecording) {
      throw new Error('Already recording');
    }

    try {
      recordingIntentRef.current = true;
      const ensureNotCancelled = () => {
        if (stopRequestedRef.current) {
          throw new Error('Recording cancelled');
        }
      };

      ensureNotCancelled();

      // Request microphone permissions
      console.log('[AudioRecorder] Requesting recording permissions...');
      const permissionResponse = await requestRecordingPermissionsAsync();
      ensureNotCancelled();

      if (!permissionResponse.granted) {
        throw new Error('Microphone permission denied. Please enable microphone access in your device settings.');
      }

      // Configure audio mode for recording
      console.log('[AudioRecorder] Configuring audio mode...');
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      ensureNotCancelled();

      console.log('[AudioRecorder] Starting recording with options:', {
        sampleRate: recordingOptions.sampleRate,
        numberOfChannels: recordingOptions.numberOfChannels,
        bitRate: recordingOptions.bitRate,
      });

      const startTime = new Date();
      setRecordingStartTime(startTime);
      ensureNotCancelled();

      // Prepare the recorder before recording (required step)
      console.log('[AudioRecorder] Preparing recorder...');
      await recorder.prepareToRecordAsync();
      ensureNotCancelled();

      console.log('[AudioRecorder] Starting recording...');
      await recorder.record();
      ensureNotCancelled();

      console.log('[AudioRecorder] Recording started at:', startTime.toISOString());
      console.log('[AudioRecorder] Recorder isRecording:', recorder.isRecording);
    } catch (error: any) {
      recordingIntentRef.current = false;
      setRecordingStartTime(null);
      if (error?.message === 'Recording cancelled') {
        console.log('[AudioRecorder] Recording start cancelled.');
      } else {
        console.error('[AudioRecorder] Failed to start recording:', error);
      }
      throw new Error(`Failed to start audio recording: ${error.message}`);
    }
  }, [recordingOptions.sampleRate, recordingOptions.numberOfChannels, recordingOptions.bitRate]);

  const stop = useCallback(async (): Promise<Blob> => {
    const recorder = recorderRef.current;

    // Guard against duplicate stop calls
    if (!recorder.isRecording && !recordingIntentRef.current) {
      console.error('[AudioRecorder] Attempted to stop when not recording. Recorder state:', {
        isRecording: recorder.isRecording,
        hasRecordingIntent: recordingIntentRef.current,
        hasRecordingStartTime: !!recordingStartTime,
      });
      throw new Error('Not recording');
    }

    stopRequestedRef.current = true;

    try {
      // Stop recording
      if (recorder.isRecording) {
        await recorder.stop();
      } else {
        console.warn('[AudioRecorder] Recorder already stopped before stop() call, continuing cleanup.');
      }

      // Get URI from recorder
      let uri = recorder.uri;
      console.log('[AudioRecorder] Initial URI from recorder:', uri);

      // Workaround for Expo SDK 54 Android bug - find actual recording file
      if (recordingStartTime && (!uri || uri === '')) {
        console.log('[AudioRecorder] Using workaround to find actual recording file...');
        const actualUri = await getActualRecordingUri(recordingStartTime);
        if (actualUri) {
          uri = actualUri;
          console.log('[AudioRecorder] Found actual recording URI:', uri);
        }
      }

      if (!uri || uri === '') {
        throw new Error('No recording URI found');
      }

      // Get file info
      const file = new File(uri);
      const exists = file.exists;
      console.log('[AudioRecorder] File exists:', exists);

      if (!exists) {
        throw new Error('Recording file does not exist');
      }

      // Convert URI to Blob
      const audioBlob = await uriToBlob(uri);

      console.log('[AudioRecorder] Recording converted to blob:', {
        size: audioBlob.size,
        type: audioBlob.type,
      });

      // Clean up the temporary file
      file.delete();

      // Reset start time and clear recording intent
      setRecordingStartTime(null);
      recordingIntentRef.current = false;

      return audioBlob;
    } catch (error: any) {
      recordingIntentRef.current = false;
      setRecordingStartTime(null);
      console.error('[AudioRecorder] Failed to stop recording:', error);
      throw new Error(`Failed to stop audio recording: ${error.message}`);
    } finally {
      stopRequestedRef.current = false;
    }
  }, [recordingStartTime]);

  const getSupportedMimeType = useCallback((): string | null => {
    // On native platforms, expo-audio uses m4a/AAC
    // On web, it can use webm/opus
    return 'audio/m4a';
  }, []);

  const isRecording = useCallback(() => {
    // Treat local intent as backup so callers can detect pending sessions
    return Boolean(recorderState.isRecording) || recordingIntentRef.current;
  }, [recorderState.isRecording]);

  // Return stable object using useMemo
  return useMemo(() => ({
    start,
    stop,
    isRecording,
    getSupportedMimeType,
  }), [start, stop, isRecording, getSupportedMimeType]);
}

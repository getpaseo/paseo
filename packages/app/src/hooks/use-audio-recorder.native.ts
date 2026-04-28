import {
  useAudioRecorder as useExpoAudioRecorder,
  useAudioRecorderState,
  RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { Paths, File, Directory, FileInfo } from "expo-file-system";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { AttemptCancelledError, AttemptGuard } from "@/utils/attempt-guard";

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
    const audioDir = new Directory(Paths.cache, "Audio");

    if (!audioDir.exists) {
      return null;
    }

    const files = audioDir.list();

    if (!files.length) {
      return null;
    }

    const validFiles = files
      .map((file) => {
        const info = file.info();
        return info;
      })
      .filter((f) => f.size && f.size > 0);

    if (validFiles.length === 0) {
      return null;
    }

    let closest: FileInfo | null = null;
    let minDiff = Infinity;

    for (const file of validFiles) {
      if (!file.creationTime || !file.uri) continue;
      const diff = Math.abs(file.creationTime - createdAt.getTime());
      if (diff < minDiff) {
        closest = file;
        minDiff = diff;
      }
    }

    if (closest) {
      const resultUri = closest.uri?.slice(0, -1) ?? null;
      return resultUri;
    }

    return null;
  } catch (e) {
    console.error("[AudioRecorder] Error finding actual recording file:", e);
    return null;
  }
}

/**
 * Convert audio file URI to Blob for daemon transport
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
    type: "audio/m4a",
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
  const attemptGuardRef = useRef(new AttemptGuard());
  const startStopMutexRef = useRef<Promise<unknown> | null>(null);

  // Store config callbacks in refs so they can update without recreating the recorder
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Create stable recording options - only recreate if actual config values change
  const recordingOptions: RecordingOptions = useMemo(
    () => ({
      ...RecordingPresets.HIGH_QUALITY,
      sampleRate: config?.sampleRate || 16000,
      numberOfChannels: config?.numberOfChannels || 1,
      bitRate: config?.bitRate || 128000,
      extension: ".m4a",
      isMeteringEnabled: !!config?.onAudioLevel, // Enable metering if callback provided
      android: {
        extension: ".m4a",
        outputFormat: "mpeg4",
        audioEncoder: "aac",
        sampleRate: config?.sampleRate || 16000,
        audioSource: "voice_communication", // Enables echo cancellation, noise suppression, auto gain control
      },
      ios: {
        extension: ".m4a",
        audioQuality: 127, // High quality
        sampleRate: config?.sampleRate || 16000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      web: {
        mimeType: "audio/webm;codecs=opus",
        bitsPerSecond: config?.bitRate || 128000,
      },
    }),
    [config?.sampleRate, config?.numberOfChannels, config?.bitRate, config?.onAudioLevel],
  );

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
      throw new Error("Already recording");
    }

    try {
      const attemptId = attemptGuardRef.current.next();
      attemptGuardRef.current.assertCurrent(attemptId);

      // Request microphone permissions
      const permissionResponse = await requestRecordingPermissionsAsync();
      attemptGuardRef.current.assertCurrent(attemptId);

      if (!permissionResponse.granted) {
        throw new Error(
          "Microphone permission denied. Please enable microphone access in your device settings.",
        );
      }

      // Configure audio mode for recording
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      attemptGuardRef.current.assertCurrent(attemptId);

      const startTime = new Date();
      setRecordingStartTime(startTime);
      attemptGuardRef.current.assertCurrent(attemptId);

      // Prepare the recorder before recording (required step)
      await recorder.prepareToRecordAsync();
      attemptGuardRef.current.assertCurrent(attemptId);

      await recorder.record();
      attemptGuardRef.current.assertCurrent(attemptId);
    } catch (error: any) {
      setRecordingStartTime(null);
      if (error instanceof AttemptCancelledError) {
        return;
      }
      if (error?.message !== "Recording cancelled") {
        console.error("[AudioRecorder] Failed to start recording:", error);
      }
      throw new Error(`Failed to start audio recording: ${error.message}`);
    }
  }, [recordingOptions.sampleRate, recordingOptions.numberOfChannels, recordingOptions.bitRate]);

  const stop = useCallback(async (): Promise<Blob> => {
    const recorder = recorderRef.current;

    // Cancel any in-flight start attempt and serialize stop/cleanup.
    attemptGuardRef.current.cancel();
    if (startStopMutexRef.current) {
      await startStopMutexRef.current.catch(() => undefined);
    }

    try {
      const stopPromise = (async () => {
        // Stop recording
        if (recorder.isRecording) {
          await recorder.stop();
        } else {
          console.warn(
            "[AudioRecorder] Recorder already stopped before stop() call, continuing cleanup.",
          );
        }

        // Get URI from recorder
        let uri = recorder.uri;

        // Workaround for Expo SDK 54 Android bug - find actual recording file
        if (recordingStartTime && (!uri || uri === "")) {
          const actualUri = await getActualRecordingUri(recordingStartTime);
          if (actualUri) {
            uri = actualUri;
          }
        }

        if (!uri || uri === "") {
          // Cancellation / early stop: return an empty blob, but guarantee cleanup.
          setRecordingStartTime(null);
          return new Blob([], { type: "audio/m4a" });
        }

        // Get file info
        const file = new File(uri);
        const exists = file.exists;

        if (!exists) {
          setRecordingStartTime(null);
          return new Blob([], { type: "audio/m4a" });
        }

        // Convert URI to Blob
        const audioBlob = await uriToBlob(uri);

        // Clean up the temporary file
        file.delete();

        // Reset start time
        setRecordingStartTime(null);

        return audioBlob;
      })();
      startStopMutexRef.current = stopPromise;
      return await stopPromise;
    } catch (error: any) {
      setRecordingStartTime(null);
      console.error("[AudioRecorder] Failed to stop recording:", error);
      throw new Error(`Failed to stop audio recording: ${error.message}`);
    } finally {
      startStopMutexRef.current = null;
    }
  }, [recordingStartTime]);

  const getSupportedMimeType = useCallback((): string | null => {
    // On native platforms, expo-audio uses m4a/AAC
    // On web, it can use webm/opus
    return "audio/m4a";
  }, []);

  const isRecording = useCallback(() => {
    return Boolean(recorderState.isRecording);
  }, [recorderState.isRecording]);

  // Return stable object using useMemo
  return useMemo(
    () => ({
      start,
      stop,
      isRecording,
      getSupportedMimeType,
    }),
    [start, stop, isRecording, getSupportedMimeType],
  );
}

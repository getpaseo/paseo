import type {
  AudioEngine,
  AudioEngineCallbacks,
  AudioEngineOptions,
  AudioPlaybackSource,
} from "./audio-engine-types";

import type * as TwoWayAudio from "@getpaseo/expo-two-way-audio";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { AttemptCancelledError } from "@/utils/attempt-guard";
import { createPlaybackQueue } from "./playback";
import { playFile } from "./file-playback";
import { playPcm16 } from "./pcm";

export interface NativeCaptureStartOptions {
  /**
   * Aborting cancels a start still waiting on microphone permission or native
   * initialization: it rejects with AttemptCancelledError and never starts capture.
   */
  signal?: AbortSignal;
}

export interface NativeAudioEngine extends AudioEngine {
  startCapture(options?: NativeCaptureStartOptions): Promise<void>;
}

export function createAudioEngine(
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineOptions,
): NativeAudioEngine {
  return createNativeAudioEngine(require("@getpaseo/expo-two-way-audio"), callbacks, options);
}

/** The engine over a given native module; tests pass a fake of the OS audio APIs. */
export function createNativeAudioEngine(
  native: typeof TwoWayAudio,
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineOptions,
): NativeAudioEngine {
  const refs: {
    initialized: boolean;
    captureActive: boolean;
    muted: boolean;
    destroyed: boolean;
  } = {
    initialized: false,
    captureActive: false,
    muted: false,
    destroyed: false,
  };

  const microphoneSubscription = native.addExpoTwoWayAudioEventListener(
    "onMicrophoneData",
    (event: { data: Uint8Array }) => {
      if (!refs.captureActive || refs.muted) {
        return;
      }
      const pcm = event.data;
      callbacks.onCaptureData(pcm);
    },
  );
  const volumeSubscription = native.addExpoTwoWayAudioEventListener(
    "onInputVolumeLevelData",
    (event: { data: number }) => {
      if (!refs.captureActive) {
        return;
      }
      const level = refs.muted ? 0 : event.data;
      callbacks.onVolumeLevel(level);
    },
  );
  const interruptionSubscription = native.addExpoTwoWayAudioEventListener(
    "onAudioInterruption",
    (event: { data: string }) => {
      if (event.data === "capture_paused" || event.data === "capture_resumed") {
        if (refs.captureActive) {
          callbacks.onCaptureAvailabilityChange?.(event.data === "capture_resumed");
        }
        return;
      }
      if (event.data !== "blocked") {
        return;
      }
      const wasCaptureActive = refs.captureActive;
      refs.captureActive = false;
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      if (wasCaptureActive) {
        callbacks.onInterruption?.();
      }
    },
  );

  async function ensureInitialized(): Promise<void> {
    if (refs.destroyed) {
      throw new AttemptCancelledError("Audio engine was destroyed");
    }
    if (refs.initialized) {
      return;
    }
    const success = await native.initialize();
    if (!success) {
      throw new Error("expo-two-way-audio: native initialize() returned false");
    }
    if (refs.destroyed) {
      // Destroyed while initializing: destroy() saw nothing to tear down.
      native.tearDown();
      throw new AttemptCancelledError("Audio engine was destroyed");
    }
    refs.initialized = true;
  }

  function throwIfStartCancelled(signal: AbortSignal | undefined): void {
    if (refs.destroyed || signal?.aborted) {
      throw new AttemptCancelledError("Audio capture start was cancelled");
    }
  }

  /**
   * Release the OS audio session as soon as we are neither capturing nor playing.
   * Holding it keeps the user's background music paused — on iOS the non-mixing
   * `.playAndRecord` category survives backgrounding and is re-asserted on every
   * foreground, so an unreleased session means their music never comes back.
   */
  function releaseSessionIfIdle(): void {
    if (!refs.initialized || refs.destroyed) {
      return;
    }
    if (refs.captureActive || playback.isPlaying()) {
      return;
    }
    // The wrapper no-ops on binaries whose native module predates this function.
    native.releaseAudioSession();
  }

  async function ensureMicrophonePermission(): Promise<void> {
    let permission = await native.getMicrophonePermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      permission = await native.requestMicrophonePermissionsAsync().catch(() => null);
    }
    if (!permission?.granted) {
      throw new Error(
        "Microphone permission is required to capture audio. Please enable microphone access in system settings.",
      );
    }
  }

  let nextFileId = 0;
  async function playAudio(audio: AudioPlaybackSource, signal: AbortSignal): Promise<number> {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (signal.aborted) throw new Error("Playback stopped");
    if (audio.type.startsWith("audio/pcm")) {
      await ensureInitialized();
      return playPcm16(bytes, audio.type, signal, native);
    }
    // Capture owns its audio session while active. File playback alone must not
    // initialize the microphone or the native two-way engine.
    if (!refs.captureActive) {
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        interruptionMode: "duckOthers",
        interruptionModeAndroid: "duckOthers",
      });
    }
    if (signal.aborted) throw new Error("Playback stopped");
    // AVPlayer needs a file extension to recognize local encoded audio on iOS.
    const extension =
      {
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/wave": "wav",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/aac": "aac",
        "audio/ogg": "ogg",
        "audio/flac": "flac",
      }[audio.type.split(";")[0].trim()] ?? "audio";
    const file = new File(Paths.cache, `paseo-audio-${Date.now()}-${nextFileId++}.${extension}`);
    try {
      file.write(bytes);
      const player = createAudioPlayer(file.uri, {
        updateInterval: 100,
        keepAudioSessionActive: refs.captureActive,
      });
      return await playFile(player, signal);
    } finally {
      if (file.exists) file.delete();
    }
  }
  const playback = createPlaybackQueue(playAudio, releaseSessionIfIdle);

  return {
    async initialize() {
      await ensureInitialized();
    },

    async destroy() {
      if (refs.destroyed) {
        return;
      }
      refs.destroyed = true;
      playback.destroy();
      if (refs.captureActive) {
        native.toggleRecording(false);
        refs.captureActive = false;
      }
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      if (refs.initialized) {
        native.tearDown();
        refs.initialized = false;
      }
      microphoneSubscription.remove();
      volumeSubscription.remove();
      interruptionSubscription.remove();
    },

    async startCapture(startOptions) {
      if (refs.captureActive) {
        return;
      }
      const signal = startOptions?.signal;

      try {
        // Permission and initialization can wait on the user or the OS; a destroy or
        // an abort in that time must not leave capture running with no owner.
        throwIfStartCancelled(signal);
        await ensureMicrophonePermission();
        throwIfStartCancelled(signal);
        await ensureInitialized();
        throwIfStartCancelled(signal);
        const isRecording =
          options?.captureMode === "dictation"
            ? native.startDictation()
            : native.toggleRecording(true);
        if (!isRecording) {
          throw new Error(
            "Microphone capture could not start because Android audio focus is unavailable.",
          );
        }
        refs.captureActive = true;
      } catch (error) {
        if (error instanceof AttemptCancelledError) {
          releaseSessionIfIdle();
          throw error;
        }
        const wrapped = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(wrapped);
        throw wrapped;
      }
    },

    async stopCapture() {
      if (refs.captureActive) {
        native.toggleRecording(false);
      }
      refs.captureActive = false;
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      callbacks.onCaptureAvailabilityChange?.(true);
      releaseSessionIfIdle();
    },

    toggleMute() {
      refs.muted = !refs.muted;
      if (refs.muted) {
        callbacks.onVolumeLevel(0);
      }
      return refs.muted;
    },

    isMuted() {
      return refs.muted;
    },

    play: playback.play,
    stop: playback.stop,
    clearQueue: playback.clearQueue,
    isPlaying: playback.isPlaying,
  };
}

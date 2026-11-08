import type {
  AudioEngine,
  AudioEngineCallbacks,
  AudioEngineOptions,
  AudioPlaybackSource,
} from "./audio-engine-types";

import { createNativeEngineLease, type NativeEngineLease } from "./native-engine-lease";
import { createPlaybackQueue } from "./playback";
import { playPcm16 } from "./pcm";

interface NativeSubscription {
  remove(): void;
}

interface MicrophonePermission {
  granted: boolean;
}

/** The surface of `@getpaseo/expo-two-way-audio` the engine drives. */
export interface TwoWayAudioModule {
  initialize(): Promise<boolean>;
  tearDown(): void;
  toggleRecording(value: boolean): boolean;
  startDictation(): boolean;
  releaseAudioSession(): void;
  playPCMData(data: Uint8Array): void;
  getMicrophonePermissionsAsync(): Promise<MicrophonePermission>;
  requestMicrophonePermissionsAsync(): Promise<MicrophonePermission>;
  addExpoTwoWayAudioEventListener(
    event: "onMicrophoneData",
    listener: (event: { data: Uint8Array }) => void,
  ): NativeSubscription;
  addExpoTwoWayAudioEventListener(
    event: "onInputVolumeLevelData",
    listener: (event: { data: number }) => void,
  ): NativeSubscription;
  addExpoTwoWayAudioEventListener(
    event: "onAudioInterruption",
    listener: (event: { data: string }) => void,
  ): NativeSubscription;
}

export interface NativeAudioEngineDeps {
  native: TwoWayAudioModule & Parameters<typeof playPcm16>[3];
  /** Plays encoded audio (wav, mp3, ...) through the platform player. */
  playEncodedAudio(
    bytes: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
    context: { isCaptureActive(): boolean },
  ): Promise<number>;
}

// Voice mode and dictation each create an engine, but the native module holds a single engine
// per app. Every JS engine on the same module shares one lease, so one engine's teardown
// cannot free the native engine another still uses (#4147).
const leases = new WeakMap<TwoWayAudioModule, NativeEngineLease>();

function leaseFor(native: TwoWayAudioModule): NativeEngineLease {
  let lease = leases.get(native);
  if (!lease) {
    lease = createNativeEngineLease(native);
    leases.set(native, lease);
  }
  return lease;
}

export function createNativeAudioEngine(
  deps: NativeAudioEngineDeps,
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineOptions,
): AudioEngine {
  const { native } = deps;
  const lease = leaseFor(native);

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

  let initializing: Promise<void> | null = null;
  async function ensureInitialized(): Promise<void> {
    if (refs.initialized) {
      return;
    }
    initializing ??= (async () => {
      try {
        await lease.acquire();
        if (refs.destroyed) {
          lease.release();
          return;
        }
        refs.initialized = true;
      } finally {
        initializing = null;
      }
    })();
    await initializing;
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

  async function playAudio(audio: AudioPlaybackSource, signal: AbortSignal): Promise<number> {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (signal.aborted) throw new Error("Playback stopped");
    if (audio.type.startsWith("audio/pcm")) {
      await ensureInitialized();
      return playPcm16(bytes, audio.type, signal, native);
    }
    return deps.playEncodedAudio(bytes, audio.type, signal, {
      isCaptureActive: () => refs.captureActive,
    });
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
        refs.initialized = false;
        // Another engine may keep the native engine alive, so teardown alone no longer
        // hands back the OS audio session. Release it while idle so background music
        // resumes; the native module keeps it while anything is still recording or playing.
        native.releaseAudioSession();
        lease.release();
      }
      microphoneSubscription.remove();
      volumeSubscription.remove();
      interruptionSubscription.remove();
    },

    async startCapture() {
      if (refs.captureActive) {
        return;
      }

      try {
        await ensureMicrophonePermission();
        await ensureInitialized();
        const isRecording =
          options?.captureMode === "dictation"
            ? native.startDictation()
            : native.toggleRecording(true);
        if (!isRecording) {
          throw new Error(
            "Microphone capture could not start. Another app may be using the microphone.",
          );
        }
        refs.captureActive = true;
      } catch (error) {
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

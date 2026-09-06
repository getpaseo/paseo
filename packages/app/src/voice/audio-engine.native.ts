import type {
  AudioEngine,
  AudioEngineCallbacks,
  AudioPlaybackSource,
} from "@/voice/audio-engine-types";

interface QueuedAudio {
  audio: AudioPlaybackSource;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
}

export type NativeAudioModule = Pick<
  typeof import("@getpaseo/expo-two-way-audio"),
  | "initialize"
  | "tearDown"
  | "toggleRecording"
  | "releaseAudioSession"
  | "addExpoTwoWayAudioEventListener"
  | "resumePlayback"
  | "playPCMData"
  | "stopPlayback"
> & {
  getMicrophonePermissionsAsync(): Promise<NativeMicrophonePermission>;
  requestMicrophonePermissionsAsync(): Promise<NativeMicrophonePermission>;
};

interface NativeMicrophonePermission {
  granted: boolean;
}

const captureOwners = new WeakMap<NativeAudioModule, object>();
const playbackOwners = new WeakMap<NativeAudioModule, object>();
const nativeModuleUsers = new WeakMap<NativeAudioModule, number>();

interface AudioEngineTraceOptions {
  nativeModule?: NativeAudioModule;
  traceLabel?: string;
}

function parsePcmSampleRate(mimeType: string): number | null {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) {
    return null;
  }
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) {
    return pcm;
  }

  const inputSamples = Math.floor(pcm.length / 2);
  const outputSamples = Math.floor((inputSamples * toRate) / fromRate);
  const out = new Uint8Array(outputSamples * 2);
  const ratio = fromRate / toRate;

  const readInt16 = (sampleIndex: number): number => {
    const i = sampleIndex * 2;
    if (i + 1 >= pcm.length) {
      return 0;
    }
    const lo = pcm[i];
    const hi = pcm[i + 1];
    let value = (hi << 8) | lo;
    if (value & 0x8000) {
      value = value - 0x10000;
    }
    return value;
  };

  const writeInt16 = (sampleIndex: number, value: number): void => {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(value)));
    const i = sampleIndex * 2;
    out[i] = clamped & 0xff;
    out[i + 1] = (clamped >> 8) & 0xff;
  };

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const s0 = readInt16(i0);
    const s1 = readInt16(Math.min(inputSamples - 1, i0 + 1));
    writeInt16(i, s0 + (s1 - s0) * frac);
  }

  return out;
}

export function createAudioEngine(
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineTraceOptions,
): AudioEngine {
  const native: NativeAudioModule =
    options?.nativeModule ?? require("@getpaseo/expo-two-way-audio");
  nativeModuleUsers.set(native, (nativeModuleUsers.get(native) ?? 0) + 1);

  const refs: {
    initialized: boolean;
    captureActive: boolean;
    muted: boolean;
    queue: QueuedAudio[];
    processingQueue: boolean;
    playbackTimeout: ReturnType<typeof setTimeout> | null;
    activePlayback: {
      resolve: (duration: number) => void;
      reject: (error: Error) => void;
      settled: boolean;
    } | null;
    destroyed: boolean;
  } = {
    initialized: false,
    captureActive: false,
    muted: false,
    queue: [],
    processingQueue: false,
    playbackTimeout: null,
    activePlayback: null,
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
      if (event.data !== "blocked") {
        return;
      }
      const wasCaptureActive = refs.captureActive;
      refs.captureActive = false;
      if (captureOwners.get(native) === refs) captureOwners.delete(native);
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      if (wasCaptureActive) {
        callbacks.onInterruption?.();
      }
    },
  );

  async function ensureInitialized(): Promise<void> {
    if (refs.destroyed) throw new Error("Audio engine was destroyed");
    // Initialization belongs to the shared module, not an individual wrapper.
    const success = await native.initialize();
    if (refs.destroyed) {
      if (nativeModuleUsers.get(native) === 0) native.tearDown();
      else if (!captureOwners.has(native) && !playbackOwners.has(native))
        native.releaseAudioSession();
      throw new Error("Audio engine was destroyed");
    }
    if (!success) {
      throw new Error("expo-two-way-audio: native initialize() returned false");
    }
    refs.initialized = true;
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
    if (refs.captureActive || refs.activePlayback || refs.queue.length > 0) {
      return;
    }
    if (playbackOwners.get(native) === refs) {
      native.stopPlayback();
      playbackOwners.delete(native);
    }
    if (captureOwners.has(native) || playbackOwners.has(native)) return;
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

  function clearPlaybackTimeout(): void {
    if (refs.playbackTimeout) {
      clearTimeout(refs.playbackTimeout);
      refs.playbackTimeout = null;
    }
  }

  async function playAudio(audio: AudioPlaybackSource): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const active = { resolve, reject, settled: false };
      refs.activePlayback = active;
      const isCurrent = () => refs.activePlayback === active && !active.settled;

      ensureInitialized()
        .then(async () => {
          if (!isCurrent()) return null;
          return await audio.arrayBuffer();
        })
        .then((arrayBuffer) => {
          if (!arrayBuffer || !isCurrent()) return;
          const pcm = new Uint8Array(arrayBuffer);
          const inputRate = parsePcmSampleRate(audio.type || "") ?? 24000;

          // Native AudioEngine expects 16kHz PCM16
          const pcm16k = resamplePcm16(pcm, inputRate, 16000);
          const durationSec = pcm16k.length / 2 / 16000;

          if (refs.destroyed) throw new Error("Audio engine was destroyed");
          playbackOwners.set(native, refs);
          native.resumePlayback();
          native.playPCMData(pcm16k);

          clearPlaybackTimeout();
          let tailWaited = false;
          const finish = () => {
            if (!isCurrent()) {
              return;
            }
            clearPlaybackTimeout();
            // Native output can lag the duration estimate. Pad only the final
            // standalone clip before stopping the player and releasing audio.
            if (!refs.captureActive && refs.queue.length === 0 && !tailWaited) {
              tailWaited = true;
              refs.playbackTimeout = setTimeout(finish, 200);
              return;
            }
            active.settled = true;
            refs.activePlayback = null;
            resolve(durationSec);
          };
          refs.playbackTimeout = setTimeout(finish, durationSec * 1000);
          return undefined;
        })
        .catch((error: unknown) => {
          if (isCurrent()) {
            clearPlaybackTimeout();
            active.settled = true;
            refs.activePlayback = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
    });
  }

  async function processQueue(): Promise<void> {
    if (refs.processingQueue || refs.queue.length === 0) {
      return;
    }

    refs.processingQueue = true;
    while (refs.queue.length > 0) {
      const item = refs.queue.shift()!;
      try {
        const duration = await playAudio(item.audio);
        item.resolve(duration);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    refs.processingQueue = false;
    releaseSessionIfIdle();
  }

  return {
    async initialize() {
      await ensureInitialized();
    },

    async destroy() {
      if (refs.destroyed) return;
      refs.destroyed = true;
      try {
        const ownedAudio =
          captureOwners.get(native) === refs || playbackOwners.get(native) === refs;
        this.stop();
        this.clearQueue();
        if (captureOwners.get(native) === refs) {
          native.toggleRecording(false);
          captureOwners.delete(native);
        }
        refs.captureActive = false;
        clearPlaybackTimeout();
        refs.muted = false;
        callbacks.onVolumeLevel(0);
        const remainingUsers = (nativeModuleUsers.get(native) ?? 1) - 1;
        if (remainingUsers === 0) native.tearDown();
        else if (ownedAudio) native.releaseAudioSession();
        nativeModuleUsers.set(native, remainingUsers);
        refs.initialized = false;
        microphoneSubscription.remove();
        volumeSubscription.remove();
        interruptionSubscription.remove();
      } catch (error) {
        refs.destroyed = false;
        throw error;
      }
    },

    async startCapture() {
      if (refs.captureActive) {
        return;
      }

      try {
        await ensureMicrophonePermission();
        await ensureInitialized();
        const isRecording = native.toggleRecording(true);
        if (!isRecording) {
          throw new Error(
            "Microphone capture could not start because Android audio focus is unavailable.",
          );
        }
        captureOwners.set(native, refs);
        refs.captureActive = true;
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(wrapped);
        throw wrapped;
      }
    },

    async stopCapture() {
      if (captureOwners.get(native) === refs) {
        native.toggleRecording(false);
        captureOwners.delete(native);
      }
      refs.captureActive = false;
      refs.muted = false;
      callbacks.onVolumeLevel(0);
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

    async play(audio: AudioPlaybackSource) {
      return await new Promise<number>((resolve, reject) => {
        refs.queue.push({ audio, resolve, reject });
        if (!refs.processingQueue) {
          void processQueue();
        }
      });
    },

    stop() {
      if (playbackOwners.get(native) === refs) {
        native.stopPlayback();
        playbackOwners.delete(native);
      }
      clearPlaybackTimeout();
      const active = refs.activePlayback;
      refs.activePlayback = null;
      if (active && !active.settled) {
        active.settled = true;
        active.reject(new Error("Playback stopped"));
      }
      releaseSessionIfIdle();
    },

    clearQueue() {
      while (refs.queue.length > 0) {
        refs.queue.shift()!.reject(new Error("Playback stopped"));
      }
      releaseSessionIfIdle();
    },

    isPlaying() {
      return refs.activePlayback !== null;
    },
  };
}

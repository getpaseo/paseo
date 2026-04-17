import { requireOptionalNativeModule } from "expo-modules-core";
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

interface AudioEngineTraceOptions {
  traceLabel?: string;
}

interface ExpoTwoWayAudioNativeModule {
  initialize: () => Promise<boolean> | boolean;
  toggleRecording: (value: boolean) => boolean;
  playPCMData: (data: Uint8Array) => number;
  stopPlayback: () => void;
  tearDown: () => void;
  resumePlayback?: () => void;
  addListener?: (
    eventName: string,
    handler: (event: any) => void,
  ) => { remove?: () => void } | void;
  getMicrophonePermissionsAsync?: () => Promise<{ granted?: boolean } | null>;
  requestMicrophonePermissionsAsync?: () => Promise<{ granted?: boolean } | null>;
}

interface LoadedExpoTwoWayAudioNativeModule extends ExpoTwoWayAudioNativeModule {
  addExpoTwoWayAudioEventListener: (
    eventName: string,
    handler: (event: any) => void,
  ) => { remove: () => void };
  getMicrophonePermissionsAsync: () => Promise<{ granted?: boolean } | null>;
  requestMicrophonePermissionsAsync: () => Promise<{ granted?: boolean } | null>;
}

function createUnavailableAudioEngine(
  callbacks: AudioEngineCallbacks,
  errorMessage: string,
): AudioEngine {
  const buildError = (): Error => new Error(errorMessage);

  async function rejectUnavailable(): Promise<never> {
    const error = buildError();
    callbacks.onError?.(error);
    throw error;
  }

  return {
    async initialize() {
      return await rejectUnavailable();
    },

    async destroy() {},

    async startCapture() {
      return await rejectUnavailable();
    },

    async stopCapture() {},

    toggleMute() {
      return false;
    },

    isMuted() {
      return false;
    },

    async play() {
      return await rejectUnavailable();
    },

    stop() {},

    clearQueue() {},

    isPlaying() {
      return false;
    },
  };
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
    const lo = pcm[i]!;
    const hi = pcm[i + 1]!;
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
  _options?: AudioEngineTraceOptions,
): AudioEngine {
  const nativeModule = requireOptionalNativeModule<ExpoTwoWayAudioNativeModule>("ExpoTwoWayAudio");
  const native =
    nativeModule && typeof nativeModule.addListener === "function"
      ? {
          ...nativeModule,
          addExpoTwoWayAudioEventListener(eventName: string, handler: (event: any) => void) {
            return nativeModule.addListener?.(eventName, handler) ?? { remove() {} };
          },
        }
      : null;

  const hasNativeBindings =
    native &&
    typeof native.addExpoTwoWayAudioEventListener === "function" &&
    typeof native.initialize === "function" &&
    typeof native.toggleRecording === "function" &&
    typeof native.playPCMData === "function" &&
    typeof native.stopPlayback === "function" &&
    typeof native.tearDown === "function";

  if (!hasNativeBindings) {
    return createUnavailableAudioEngine(
      callbacks,
      "Voice is unavailable on this device because the native audio module is not registered.",
    );
  }

  const loadedNative = native as LoadedExpoTwoWayAudioNativeModule;

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

  const microphoneSubscription = loadedNative.addExpoTwoWayAudioEventListener(
    "onMicrophoneData",
    (event: any) => {
      if (!refs.captureActive || refs.muted) {
        return;
      }
      const pcm = event.data as Uint8Array;
      callbacks.onCaptureData(pcm);
    },
  );
  const volumeSubscription = loadedNative.addExpoTwoWayAudioEventListener(
    "onInputVolumeLevelData",
    (event: any) => {
      if (!refs.captureActive) {
        return;
      }
      const level = refs.muted ? 0 : event.data;
      callbacks.onVolumeLevel(level);
    },
  );

  async function ensureInitialized(): Promise<void> {
    if (refs.initialized) {
      return;
    }
    const success = await loadedNative.initialize();
    if (!success) {
      throw new Error("expo-two-way-audio: native initialize() returned false");
    }
    refs.initialized = true;
  }

  async function ensureMicrophonePermission(): Promise<void> {
    let permission = await loadedNative.getMicrophonePermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      permission = await loadedNative.requestMicrophonePermissionsAsync().catch(() => null);
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
    await ensureInitialized();

    return await new Promise<number>(async (resolve, reject) => {
      refs.activePlayback = { resolve, reject, settled: false };

      try {
        const arrayBuffer = await audio.arrayBuffer();
        const pcm = new Uint8Array(arrayBuffer);
        const inputRate = parsePcmSampleRate(audio.type || "") ?? 24000;

        // Native AudioEngine expects 16kHz PCM16
        const pcm16k = resamplePcm16(pcm, inputRate, 16000);
        const durationSec = pcm16k.length / 2 / 16000;

        loadedNative.resumePlayback?.();
        loadedNative.playPCMData(pcm16k);

        clearPlaybackTimeout();
        refs.playbackTimeout = setTimeout(() => {
          clearPlaybackTimeout();
          const active = refs.activePlayback;
          if (!active || active.settled) {
            return;
          }
          active.settled = true;
          refs.activePlayback = null;
          resolve(durationSec);
        }, durationSec * 1000);
      } catch (error) {
        clearPlaybackTimeout();
        const active = refs.activePlayback;
        if (active && !active.settled) {
          active.settled = true;
          refs.activePlayback = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
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
  }

  return {
    async initialize() {
      await ensureInitialized();
    },

    async destroy() {
      if (refs.destroyed) {
        return;
      }
      refs.destroyed = true;
      this.stop();
      this.clearQueue();
      if (refs.captureActive) {
        loadedNative.toggleRecording(false);
        refs.captureActive = false;
      }
      clearPlaybackTimeout();
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      if (refs.initialized) {
        loadedNative.tearDown();
        refs.initialized = false;
      }
      microphoneSubscription.remove();
      volumeSubscription.remove();
    },

    async startCapture() {
      if (refs.captureActive) {
        return;
      }

      try {
        await ensureMicrophonePermission();
        await ensureInitialized();
        loadedNative.toggleRecording(true);
        refs.captureActive = true;
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(wrapped);
        throw wrapped;
      }
    },

    async stopCapture() {
      if (refs.captureActive) {
        loadedNative.toggleRecording(false);
      }
      refs.captureActive = false;
      refs.muted = false;
      callbacks.onVolumeLevel(0);
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
      loadedNative.stopPlayback();
      clearPlaybackTimeout();
      const active = refs.activePlayback;
      refs.activePlayback = null;
      if (active && !active.settled) {
        active.settled = true;
        active.reject(new Error("Playback stopped"));
      }
    },

    clearQueue() {
      while (refs.queue.length > 0) {
        refs.queue.shift()!.reject(new Error("Playback stopped"));
      }
      refs.processingQueue = false;
    },

    isPlaying() {
      return refs.activePlayback !== null;
    },
  };
}

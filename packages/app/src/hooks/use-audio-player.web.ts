import { useMemo, useRef, useState } from "react";

export interface AudioPlayerOptions {
  isDetecting?: () => boolean;
  isSpeaking?: () => boolean;
}

/**
 * Web audio player for server-provided audio chunks.
 *
 * Supports:
 * - `audio/pcm` (assumed PCM16 LE, mono, default 24kHz unless `rate=` is present)
 * - formats supported by `AudioContext.decodeAudioData` (e.g. mp3)
 */
export function useAudioPlayer(options?: AudioPlayerOptions) {
  const [isPlayingState, setIsPlayingState] = useState(false);

  type QueuedAudio = {
    audioData: Blob;
    resolve: (duration: number) => void;
    reject: (error: Error) => void;
  };

  const audioContextRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<QueuedAudio[]>([]);
  const suppressedQueueRef = useRef<QueuedAudio[]>([]);
  const isProcessingQueueRef = useRef(false);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activePlaybackRef = useRef<{
    source: AudioBufferSourceNode;
    resolve: (duration: number) => void;
    reject: (error: Error) => void;
    settled: boolean;
  } | null>(null);

  const decodeAudioData = async (context: AudioContext, buffer: ArrayBuffer): Promise<AudioBuffer> => {
    const maybePromise = context.decodeAudioData(buffer);
    if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === "function") {
      return maybePromise as Promise<AudioBuffer>;
    }
    return await new Promise<AudioBuffer>((resolve, reject) => {
      context.decodeAudioData(buffer, resolve, reject);
    });
  };

  const parsePcmSampleRate = (mimeType: string): number | null => {
    const match = /rate=(\\d+)/i.exec(mimeType);
    if (!match) {
      return null;
    }
    const rate = Number(match[1]);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  };

  const pcm16LeToAudioBuffer = (context: AudioContext, bytes: Uint8Array, sampleRate: number): AudioBuffer => {
    const sampleCount = Math.floor(bytes.length / 2);
    const audioBuffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const lo = bytes[i * 2]!;
      const hi = bytes[i * 2 + 1]!;
      let value = (hi << 8) | lo;
      if (value & 0x8000) {
        value = value - 0x10000;
      }
      channel[i] = value / 0x8000;
    }
    return audioBuffer;
  };

  const ensureContext = async (): Promise<AudioContext> => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === "suspended") {
        try {
          await audioContextRef.current.resume();
        } catch {
          // Best effort. If this fails due to autoplay policies, a later user gesture
          // (or explicit warmup call) can unlock it.
        }
      }
      return audioContextRef.current;
    }
    const context = new AudioContext();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // See note above.
      }
    }
    audioContextRef.current = context;
    return context;
  };

  const shouldSuppressPlayback = (): boolean => {
    return Boolean(options?.isDetecting?.()) || Boolean(options?.isSpeaking?.());
  };

  const startCheckingForClearFlags = (): void => {
    if (checkIntervalRef.current !== null) {
      return;
    }

    checkIntervalRef.current = setInterval(() => {
      const isStillBlocked = shouldSuppressPlayback();
      if (!isStillBlocked && suppressedQueueRef.current.length > 0) {
        const suppressedItems = [...suppressedQueueRef.current];
        suppressedQueueRef.current = [];
        queueRef.current = [...suppressedItems, ...queueRef.current];

        if (checkIntervalRef.current !== null) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
        }

        if (!isProcessingQueueRef.current) {
          void processQueue();
        }
      } else if (!isStillBlocked && suppressedQueueRef.current.length === 0) {
        if (checkIntervalRef.current !== null) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
        }
      }
    }, 100);
  };

  const playAudio = async (audioData: Blob): Promise<number> => {
    const context = await ensureContext();
    const arrayBuffer = await audioData.arrayBuffer();

    let audioBuffer: AudioBuffer;
    const type = (audioData.type || "").toLowerCase();

    if (type.startsWith("audio/pcm")) {
      const sampleRate = parsePcmSampleRate(type) ?? 24000;
      audioBuffer = pcm16LeToAudioBuffer(context, new Uint8Array(arrayBuffer), sampleRate);
    } else {
      audioBuffer = await decodeAudioData(context, arrayBuffer);
    }

    const durationSec = audioBuffer.duration;
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);

    return await new Promise<number>((resolve, reject) => {
      activePlaybackRef.current = { source, resolve, reject, settled: false };
      setIsPlayingState(true);

      const settleOnce = (fn: () => void) => {
        const active = activePlaybackRef.current;
        if (!active || active.source !== source || active.settled) {
          return;
        }
        active.settled = true;
        activePlaybackRef.current = null;
        setIsPlayingState(false);
        fn();
      };

      source.onended = () => {
        settleOnce(() => resolve(durationSec));
      };

      try {
        source.start();
      } catch (e) {
        settleOnce(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
  };

  const processQueue = async (): Promise<void> => {
    if (isProcessingQueueRef.current || queueRef.current.length === 0) {
      return;
    }

    isProcessingQueueRef.current = true;

    while (queueRef.current.length > 0) {
      if (shouldSuppressPlayback()) {
        suppressedQueueRef.current = [...queueRef.current, ...suppressedQueueRef.current];
        queueRef.current = [];
        startCheckingForClearFlags();
        break;
      }

      const item = queueRef.current.shift()!;
      try {
        const duration = await playAudio(item.audioData);
        item.resolve(duration);
      } catch (error) {
        item.reject(error as Error);
      }
    }

    isProcessingQueueRef.current = false;
  };

  const play = async (audioData: Blob): Promise<number> => {
    return await new Promise<number>((resolve, reject) => {
      if (shouldSuppressPlayback()) {
        suppressedQueueRef.current.push({ audioData, resolve, reject });
        startCheckingForClearFlags();
        return;
      }

      queueRef.current.push({ audioData, resolve, reject });
      if (!isProcessingQueueRef.current) {
        void processQueue();
      }
    });
  };

  const stop = (): void => {
    // Stop currently playing audio (and reject its promise)
    if (activePlaybackRef.current) {
      const active = activePlaybackRef.current;
      activePlaybackRef.current = null;
      try {
        active.source.onended = null;
        active.source.stop();
      } catch {
        // ignore
      }
      if (!active.settled) {
        active.settled = true;
        active.reject(new Error("Playback stopped"));
      }
    }

    setIsPlayingState(false);

    while (queueRef.current.length > 0) {
      queueRef.current.shift()!.reject(new Error("Playback stopped"));
    }
    while (suppressedQueueRef.current.length > 0) {
      suppressedQueueRef.current.shift()!.reject(new Error("Playback stopped"));
    }

    if (checkIntervalRef.current !== null) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }

    isProcessingQueueRef.current = false;
  };

  const clearQueue = (): void => {
    while (queueRef.current.length > 0) {
      queueRef.current.shift()!.reject(new Error("Queue cleared"));
    }
    while (suppressedQueueRef.current.length > 0) {
      suppressedQueueRef.current.shift()!.reject(new Error("Queue cleared"));
    }
    if (checkIntervalRef.current !== null) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }
  };

  return useMemo(
    () => ({
      play,
      stop,
      isPlaying: () => isPlayingState,
      clearQueue,
      warmup: async () => {
        await ensureContext();
      },
    }),
    [isPlayingState]
  );
}

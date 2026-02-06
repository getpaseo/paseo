import { useState, useRef } from "react";
import {
  initialize,
  playPCMData,
  stopPlayback,
  pausePlayback,
  resumePlayback,
} from "@boudra/expo-two-way-audio";

interface QueuedAudio {
  audioData: Blob;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
}

/**
 * Resample PCM16 audio between sample rates.
 * Speechmatics expects 16kHz.
 */
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

function parsePcmSampleRate(mimeType: string): number | null {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) {
    return null;
  }
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export interface AudioPlayerOptions {
  isDetecting?: () => boolean;
  isSpeaking?: () => boolean;
}

/**
 * Hook for audio playback using Speechmatics two-way audio with echo cancellation
 */
export function useAudioPlayer(options?: AudioPlayerOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const queueRef = useRef<QueuedAudio[]>([]);
  const suppressedQueueRef = useRef<QueuedAudio[]>([]);
  const isProcessingQueueRef = useRef(false);
  const activePlaybackRef = useRef<{
    resolve: (duration: number) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const playbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function play(audioData: Blob): Promise<number> {
    return new Promise((resolve, reject) => {
      // Check if we should suppress playback due to voice detection/speaking
      const shouldSuppress = 
        (options?.isDetecting && options.isDetecting()) ||
        (options?.isSpeaking && options.isSpeaking());

      if (shouldSuppress) {
        console.log("[AudioPlayer] Suppressing playback - voice detection/speaking active");
        // Add to suppressed queue instead
        suppressedQueueRef.current.push({ audioData, resolve, reject });
        
        // Start checking for when flags clear
        startCheckingForClearFlags();
        return;
      }

      // Add to queue with its promise handlers
      queueRef.current.push({ audioData, resolve, reject });

      // Start processing queue if not already processing
      if (!isProcessingQueueRef.current) {
        processQueue();
      }
    });
  }

  function startCheckingForClearFlags(): void {
    // Already checking
    if (checkIntervalRef.current !== null) {
      return;
    }

    console.log("[AudioPlayer] Starting to check for clear flags");
    
    checkIntervalRef.current = setInterval(() => {
      const isStillBlocked = 
        (options?.isDetecting && options.isDetecting()) ||
        (options?.isSpeaking && options.isSpeaking());

      if (!isStillBlocked && suppressedQueueRef.current.length > 0) {
        console.log("[AudioPlayer] Flags cleared - moving suppressed queue to main queue");
        
        // Move all suppressed items to main queue
        const suppressedItems = [...suppressedQueueRef.current];
        suppressedQueueRef.current = [];
        
        // Add to front of main queue (they were waiting)
        queueRef.current = [...suppressedItems, ...queueRef.current];
        
        // Stop checking
        if (checkIntervalRef.current !== null) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
        }
        
        // Start processing if not already
        if (!isProcessingQueueRef.current) {
          processQueue();
        }
      } else if (!isStillBlocked && suppressedQueueRef.current.length === 0) {
        // No more suppressed items and flags are clear - stop checking
        if (checkIntervalRef.current !== null) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
        }
      }
    }, 100); // Check every 100ms
  }

  async function processQueue(): Promise<void> {
    if (isProcessingQueueRef.current || queueRef.current.length === 0) {
      return;
    }

    isProcessingQueueRef.current = true;

    while (queueRef.current.length > 0) {
      // Before processing each item, check if flags became active
      const shouldSuppress = 
        (options?.isDetecting && options.isDetecting()) ||
        (options?.isSpeaking && options.isSpeaking());

      if (shouldSuppress) {
        console.log("[AudioPlayer] Flags became active during processing - moving remaining queue to suppressed");
        // Move remaining queue to suppressed
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
  }

  async function processNextInQueue(): Promise<void> {
    if (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      try {
        const duration = await playAudio(item.audioData);
        item.resolve(duration);
      } catch (error) {
        item.reject(error as Error);
      }
    } else {
      isProcessingQueueRef.current = false;
    }
  }

  async function playAudio(audioData: Blob): Promise<number> {
    return new Promise(async (resolve, reject) => {
      activePlaybackRef.current = { resolve, reject };
      try {
        console.log(
          `[AudioPlayer] Playing audio (${audioData.size} bytes, type: ${audioData.type})`
        );

        // Initialize audio if not already initialized
        if (!audioInitialized) {
          console.log("[AudioPlayer] Initializing audio...");
          await initialize();
          setAudioInitialized(true);
          console.log(
            "[AudioPlayer] ✅ Initialized (Speechmatics two-way audio)"
          );
        }

        // Workaround: Resume playback before playing new audio to ensure the audio engine is ready
        // This fixes the issue where playback doesn't work after calling stopPlayback()
        console.log("[AudioPlayer] Resuming playback engine...");
        resumePlayback();

        // Get PCM data from blob (server sends PCM16)
        const arrayBuffer = await audioData.arrayBuffer();
        const pcm = new Uint8Array(arrayBuffer);

        const inputRate = parsePcmSampleRate(audioData.type || "") ?? 24000;
        const pcm16k = resamplePcm16(pcm, inputRate, 16000);

        // Calculate total duration
        const samples = pcm16k.length / 2; // 16-bit = 2 bytes per sample
        const durationSec = samples / 16000; // 16kHz sample rate

        const audioSizeKb = (pcm16k.length / 1024).toFixed(2);
        console.log(
          "[AudioPlayer] 🔊 Playing audio:",
          audioSizeKb,
          "KB, duration:",
          durationSec.toFixed(2),
          "s"
        );

        setIsPlaying(true);

        // Play entire PCM data at once through Speechmatics
        playPCMData(pcm16k);

        // Clear any existing timeout
        if (playbackTimeoutRef.current) {
          clearTimeout(playbackTimeoutRef.current);
        }

        // Wait for playback to finish (estimate based on duration)
        playbackTimeoutRef.current = setTimeout(() => {
          console.log("[AudioPlayer] ✅ Playback finished");
          setIsPlaying(false);
          playbackTimeoutRef.current = null;
          activePlaybackRef.current = null;
          resolve(durationSec);
        }, durationSec * 1000);
      } catch (error) {
        console.error("[AudioPlayer] Error playing audio:", error);

        // Clear timeout on error
        if (playbackTimeoutRef.current) {
          clearTimeout(playbackTimeoutRef.current);
          playbackTimeoutRef.current = null;
        }

        setIsPlaying(false);
        activePlaybackRef.current = null;
        reject(error);
      }
    });
  }

  function stop(): void {
    if (isPlaying) {
      console.log("[AudioPlayer] 🛑 Stopping playback (interrupted)");

      // Stop native playback
      stopPlayback();

      // Clear playback timeout
      if (playbackTimeoutRef.current) {
        clearTimeout(playbackTimeoutRef.current);
        playbackTimeoutRef.current = null;
      }
    }

    setIsPlaying(false);

    // Reject the currently playing promise, if any.
    if (activePlaybackRef.current) {
      activePlaybackRef.current.reject(new Error("Playback stopped"));
      activePlaybackRef.current = null;
    }

    // Reject all pending promises in the main queue
    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      item.reject(new Error("Playback stopped"));
    }

    // Reject all pending promises in the suppressed queue
    while (suppressedQueueRef.current.length > 0) {
      const item = suppressedQueueRef.current.shift()!;
      item.reject(new Error("Playback stopped"));
    }

    // Clear check interval
    if (checkIntervalRef.current !== null) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }

    isProcessingQueueRef.current = false;
  }

  function clearQueue(): void {
    // Reject all pending promises in the main queue
    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      item.reject(new Error("Queue cleared"));
    }

    // Reject all pending promises in the suppressed queue
    while (suppressedQueueRef.current.length > 0) {
      const item = suppressedQueueRef.current.shift()!;
      item.reject(new Error("Queue cleared"));
    }

    // Clear check interval
    if (checkIntervalRef.current !== null) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }
  }

  return {
    play,
    stop,
    isPlaying: () => isPlaying,
    clearQueue,
    warmup: async () => {
      if (!audioInitialized) {
        await initialize();
        setAudioInitialized(true);
      }
      // Ensure playback engine isn't suspended after a previous stop.
      resumePlayback();
    },
  };
}

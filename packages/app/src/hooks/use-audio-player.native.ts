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
 * Resample PCM16 audio from 24kHz to 16kHz
 * OpenAI returns 24kHz, Speechmatics expects 16kHz
 */
function resamplePcm24kTo16k(pcm24k: Uint8Array): Uint8Array {
  // PCM16 = 2 bytes per sample
  const samples24k = pcm24k.length / 2;
  const samples16k = Math.floor((samples24k * 16000) / 24000);

  const pcm16k = new Uint8Array(samples16k * 2);
  const ratio = 24000 / 16000; // 1.5

  for (let i = 0; i < samples16k; i++) {
    const srcIndex = Math.floor(i * ratio) * 2;
    if (srcIndex + 1 < pcm24k.length) {
      pcm16k[i * 2] = pcm24k[srcIndex];
      pcm16k[i * 2 + 1] = pcm24k[srcIndex + 1];
    }
  }

  console.log("[AudioPlayer] Resampled PCM:", {
    input24k: pcm24k.length,
    output16k: pcm16k.length,
    durationMs: samples16k / 16,
  });

  return pcm16k;
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

        // Get PCM data from blob (server now sends PCM format)
        const arrayBuffer = await audioData.arrayBuffer();
        let pcm24k = new Uint8Array(arrayBuffer);

        // Resample from 24kHz (OpenAI) to 16kHz (Speechmatics)
        const pcm16k = resamplePcm24kTo16k(pcm24k);

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

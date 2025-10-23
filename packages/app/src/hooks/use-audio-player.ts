import { useState, useRef } from 'react';
import { initialize, playPCMData } from '@speechmatics/expo-two-way-audio';

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
  const samples16k = Math.floor(samples24k * 16000 / 24000);

  const pcm16k = new Uint8Array(samples16k * 2);
  const ratio = 24000 / 16000; // 1.5

  for (let i = 0; i < samples16k; i++) {
    const srcIndex = Math.floor(i * ratio) * 2;
    if (srcIndex + 1 < pcm24k.length) {
      pcm16k[i * 2] = pcm24k[srcIndex];
      pcm16k[i * 2 + 1] = pcm24k[srcIndex + 1];
    }
  }

  console.log('[AudioPlayer] Resampled PCM:', {
    input24k: pcm24k.length,
    output16k: pcm16k.length,
    durationMs: (samples16k / 16),
  });

  return pcm16k;
}

/**
 * Hook for audio playback using Speechmatics two-way audio with echo cancellation
 */
export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const queueRef = useRef<QueuedAudio[]>([]);
  const isProcessingQueueRef = useRef(false);

  async function play(audioData: Blob): Promise<number> {
    return new Promise((resolve, reject) => {
      // Add to queue with its promise handlers
      queueRef.current.push({ audioData, resolve, reject });

      // Start processing queue if not already processing
      if (!isProcessingQueueRef.current) {
        processQueue();
      }
    });
  }

  async function processQueue(): Promise<void> {
    if (isProcessingQueueRef.current || queueRef.current.length === 0) {
      return;
    }

    isProcessingQueueRef.current = true;

    while (queueRef.current.length > 0) {
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
      try {
        console.log(
          `[AudioPlayer] Playing audio (${audioData.size} bytes, type: ${audioData.type})`
        );

        // Initialize audio if not already initialized
        if (!audioInitialized) {
          console.log('[AudioPlayer] Initializing audio...');
          await initialize();
          setAudioInitialized(true);
          console.log('[AudioPlayer] ✅ Initialized (Speechmatics two-way audio)');
        }

        // Get PCM data from blob (server now sends PCM format)
        const arrayBuffer = await audioData.arrayBuffer();
        let pcm24k = new Uint8Array(arrayBuffer);

        // Resample from 24kHz (OpenAI) to 16kHz (Speechmatics)
        const pcm16k = resamplePcm24kTo16k(pcm24k);

        // Calculate total duration
        const samples = pcm16k.length / 2; // 16-bit = 2 bytes per sample
        const durationSec = samples / 16000; // 16kHz sample rate

        const audioSizeKb = (pcm16k.length / 1024).toFixed(2);
        console.log('[AudioPlayer] 🔊 Playing audio:', audioSizeKb, 'KB, duration:', durationSec.toFixed(2), 's');

        setIsPlaying(true);

        // Play entire PCM data at once through Speechmatics
        playPCMData(pcm16k);

        // Wait for playback to finish (estimate based on duration)
        setTimeout(() => {
          console.log('[AudioPlayer] ✅ Playback finished');
          setIsPlaying(false);
          resolve(durationSec);
        }, durationSec * 1000);

      } catch (error) {
        console.error('[AudioPlayer] Error playing audio:', error);
        setIsPlaying(false);
        reject(error);
      }
    });
  }

  function stop(): void {
    if (isPlaying) {
      console.log('[AudioPlayer] 🛑 Stopping playback (interrupted)');
    }

    setIsPlaying(false);

    // Reject all pending promises in the queue
    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      item.reject(new Error('Playback stopped'));
    }

    isProcessingQueueRef.current = false;
  }

  function clearQueue(): void {
    // Reject all pending promises in the queue
    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      item.reject(new Error('Queue cleared'));
    }
  }

  return {
    play,
    stop,
    isPlaying: () => isPlaying,
    clearQueue,
  };
}

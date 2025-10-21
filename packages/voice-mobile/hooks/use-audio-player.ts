import { useAudioPlayer as useExpoAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Paths, File } from 'expo-file-system';
import { useState, useRef, useEffect } from 'react';
import { Platform } from 'react-native';

interface QueuedAudio {
  audioData: Blob;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
}

interface AudioPlayerOptions {
  useSpeaker?: boolean;
}

/**
 * Convert Blob to file URI for expo-audio playback
 */
async function blobToFile(blob: Blob): Promise<File> {
  // Read blob as array buffer
  const arrayBuffer = await blob.arrayBuffer();

  // Create temporary file in cache directory
  const fileName = `audio_${Date.now()}.mp3`;
  const file = new File(Paths.cache, fileName);

  // Write array buffer to file
  const uint8Array = new Uint8Array(arrayBuffer);
  file.create();
  const stream = file.writableStream();
  const writer = stream.getWriter();
  await writer.write(uint8Array);
  await writer.close();

  return file;
}

/**
 * Hook for audio playback with queue system matching web version functionality
 */
export function useAudioPlayer(options?: AudioPlayerOptions) {
  const player = useExpoAudioPlayer();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const queueRef = useRef<QueuedAudio[]>([]);
  const isProcessingQueueRef = useRef(false);
  const currentRejectRef = useRef<((error: Error) => void) | null>(null);
  const currentFileRef = useRef<File | null>(null);

  // Configure audio mode based on speaker/earpiece preference
  useEffect(() => {
    async function configureAudioMode() {
      try {
        if (Platform.OS === 'android') {
          // On Android, use shouldRouteThroughEarpiece
          await setAudioModeAsync({
            shouldRouteThroughEarpiece: !options?.useSpeaker,
          });
        } else if (Platform.OS === 'ios') {
          // On iOS, the audio routing is controlled by the AVAudioSession category
          // The default category should work, but we can configure it if needed
          // For now, we rely on the iOS default behavior which routes to the receiver
          // unless the user has changed the route (e.g., via speaker button in Control Center)
        }
      } catch (error) {
        console.warn('[AudioPlayer] Failed to configure audio mode:', error);
      }
    }

    configureAudioMode();
  }, [options?.useSpeaker]);

  // Monitor playback status
  useEffect(() => {
    if (!player.playing && isPlaying && !isPaused) {
      // Playback finished
      setIsPlaying(false);
      processNextInQueue();
    }
  }, [player.playing, isPlaying, isPaused]);

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
      currentRejectRef.current = reject;

      try {
        console.log(
          `[AudioPlayer] Playing audio (${audioData.size} bytes, type: ${audioData.type})`
        );

        // Convert blob to file
        const file = await blobToFile(audioData);
        currentFileRef.current = file;

        setIsPlaying(true);
        setIsPaused(false);

        // Load and play audio
        await player.replace({ uri: file.uri });
        player.play();

        // Wait for playback to finish
        const checkInterval = setInterval(() => {
          if (!player.playing && player.duration > 0) {
            clearInterval(checkInterval);

            const duration = player.duration;
            console.log(`[AudioPlayer] Playback finished (duration: ${duration}s)`);

            setIsPlaying(false);
            currentRejectRef.current = null;

            // Clean up temporary file
            if (currentFileRef.current) {
              try {
                currentFileRef.current.delete();
              } catch (err: any) {
                console.warn('[AudioPlayer] Failed to delete temp file:', err);
              }
              currentFileRef.current = null;
            }

            resolve(duration);
          }
        }, 100);

      } catch (error) {
        console.error('[AudioPlayer] Error playing audio:', error);
        setIsPlaying(false);
        currentRejectRef.current = null;

        // Clean up temporary file
        if (currentFileRef.current) {
          try {
            currentFileRef.current.delete();
          } catch (err: any) {
            console.warn('[AudioPlayer] Failed to delete temp file:', err);
          }
          currentFileRef.current = null;
        }

        reject(error);
      }
    });
  }

  function stop(): void {
    // Stop currently playing audio
    if (player) {
      player.pause();
    }
    setIsPlaying(false);
    setIsPaused(false);

    // Clean up temporary file
    if (currentFileRef.current) {
      try {
        currentFileRef.current.delete();
      } catch (err: any) {
        console.warn('[AudioPlayer] Failed to delete temp file:', err);
      }
      currentFileRef.current = null;
    }

    // Reject the current playing promise if it exists
    if (currentRejectRef.current) {
      currentRejectRef.current(new Error('Playback stopped'));
      currentRejectRef.current = null;
    }

    // Reject all pending promises in the queue
    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      item.reject(new Error('Playback stopped'));
    }

    isProcessingQueueRef.current = false;
  }

  function pause(): void {
    if (player && isPlaying && !isPaused) {
      player.pause();
      setIsPaused(true);
      console.log('[AudioPlayer] Playback paused');
    }
  }

  function resume(): void {
    if (player && isPaused) {
      player.play();
      setIsPaused(false);
      console.log('[AudioPlayer] Playback resumed');
    }
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
    pause,
    resume,
    isPlaying: () => isPlaying,
    isPaused: () => isPaused,
    clearQueue,
  };
}

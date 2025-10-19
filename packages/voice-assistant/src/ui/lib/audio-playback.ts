export interface AudioPlayer {
  play(audioData: Blob): Promise<number>;
  stop(): void;
  isPlaying(): boolean;
  clearQueue(): void;
}

interface QueuedAudio {
  audioData: Blob;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
}

export function createAudioPlayer(): AudioPlayer {
  let currentAudio: HTMLAudioElement | null = null;
  let playing = false;
  let queue: QueuedAudio[] = [];
  let isProcessingQueue = false;
  let currentReject: ((error: Error) => void) | null = null;

  async function play(audioData: Blob): Promise<number> {
    return new Promise((resolve, reject) => {
      // Add to queue with its promise handlers
      queue.push({ audioData, resolve, reject });

      // Start processing queue if not already processing
      if (!isProcessingQueue) {
        processQueue();
      }
    });
  }

  async function processQueue(): Promise<void> {
    if (isProcessingQueue || queue.length === 0) {
      return;
    }

    isProcessingQueue = true;

    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const duration = await playAudio(item.audioData);
        item.resolve(duration);
      } catch (error) {
        item.reject(error as Error);
      }
    }

    isProcessingQueue = false;
  }

  async function playAudio(audioData: Blob): Promise<number> {
    return new Promise((resolve, reject) => {
      // Store reject handler so stop() can properly cancel current playback
      currentReject = reject;

      try {
        // Create blob URL
        const audioUrl = URL.createObjectURL(audioData);

        // Create audio element
        const audio = new Audio(audioUrl);
        currentAudio = audio;
        playing = true;

        console.log(
          `[AudioPlayer] Playing audio (${audioData.size} bytes, type: ${audioData.type})`
        );

        audio.onended = () => {
          const duration = audio.duration;
          console.log(
            `[AudioPlayer] Playback finished (duration: ${duration}s)`
          );
          playing = false;
          currentAudio = null;
          currentReject = null;

          // Clean up blob URL
          URL.revokeObjectURL(audioUrl);

          resolve(duration);
        };

        audio.onerror = (error) => {
          console.error("[AudioPlayer] Playback error:", error);
          playing = false;
          currentAudio = null;
          currentReject = null;

          // Clean up blob URL
          URL.revokeObjectURL(audioUrl);

          reject(new Error("Audio playback failed"));
        };

        // Start playback
        audio.play().catch((error) => {
          console.error("[AudioPlayer] Failed to start playback:", error);
          playing = false;
          currentAudio = null;
          currentReject = null;
          URL.revokeObjectURL(audioUrl);
          reject(error);
        });
      } catch (error) {
        console.error("[AudioPlayer] Error creating audio element:", error);
        playing = false;
        currentAudio = null;
        currentReject = null;
        reject(error);
      }
    });
  }

  function stop(): void {
    // Stop and reject currently playing audio
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      // Remove src to fully stop the audio
      currentAudio.src = "";
      currentAudio = null;
    }
    playing = false;

    // Reject the current playing promise if it exists
    if (currentReject) {
      currentReject(new Error("Playback stopped"));
      currentReject = null;
    }

    // Reject all pending promises in the queue
    while (queue.length > 0) {
      const item = queue.shift()!;
      item.reject(new Error("Playback stopped"));
    }

    isProcessingQueue = false;
  }

  function isPlayingFunc(): boolean {
    return playing;
  }

  function clearQueue(): void {
    // Reject all pending promises in the queue
    while (queue.length > 0) {
      const item = queue.shift()!;
      item.reject(new Error("Queue cleared"));
    }
  }

  return {
    play,
    stop,
    isPlaying: isPlayingFunc,
    clearQueue,
  };
}

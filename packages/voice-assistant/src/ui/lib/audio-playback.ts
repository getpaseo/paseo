export interface AudioPlayer {
  play(audioData: Blob): Promise<void>;
  stop(): void;
  isPlaying(): boolean;
  clearQueue(): void;
}

export function createAudioPlayer(): AudioPlayer {
  let currentAudio: HTMLAudioElement | null = null;
  let playing = false;
  let queue: Blob[] = [];
  let isProcessingQueue = false;

  async function play(audioData: Blob): Promise<void> {
    // Add to queue
    queue.push(audioData);

    // Start processing queue if not already processing
    if (!isProcessingQueue) {
      processQueue();
    }
  }

  async function processQueue(): Promise<void> {
    if (isProcessingQueue || queue.length === 0) {
      return;
    }

    isProcessingQueue = true;

    while (queue.length > 0) {
      const audioData = queue.shift()!;
      await playAudio(audioData);
    }

    isProcessingQueue = false;
  }

  async function playAudio(audioData: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create blob URL
        const audioUrl = URL.createObjectURL(audioData);

        // Create audio element
        const audio = new Audio(audioUrl);
        currentAudio = audio;
        playing = true;

        console.log(`[AudioPlayer] Playing audio (${audioData.size} bytes, type: ${audioData.type})`);

        audio.onended = () => {
          console.log('[AudioPlayer] Playback finished');
          playing = false;
          currentAudio = null;

          // Clean up blob URL
          URL.revokeObjectURL(audioUrl);

          resolve();
        };

        audio.onerror = (error) => {
          console.error('[AudioPlayer] Playback error:', error);
          playing = false;
          currentAudio = null;

          // Clean up blob URL
          URL.revokeObjectURL(audioUrl);

          reject(new Error('Audio playback failed'));
        };

        // Start playback
        audio.play().catch((error) => {
          console.error('[AudioPlayer] Failed to start playback:', error);
          playing = false;
          currentAudio = null;
          URL.revokeObjectURL(audioUrl);
          reject(error);
        });
      } catch (error) {
        console.error('[AudioPlayer] Error creating audio element:', error);
        playing = false;
        currentAudio = null;
        reject(error);
      }
    });
  }

  function stop(): void {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    playing = false;
    queue = [];
    isProcessingQueue = false;
  }

  function isPlayingFunc(): boolean {
    return playing;
  }

  function clearQueue(): void {
    queue = [];
  }

  return {
    play,
    stop,
    isPlaying: isPlayingFunc,
    clearQueue,
  };
}

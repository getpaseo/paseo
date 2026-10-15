export interface FilePlaybackStatus {
  playbackState: string;
  isLoaded: boolean;
  didJustFinish: boolean;
  duration: number;
}

export interface FilePlayer {
  play(): void;
  remove(): void;
  addListener(
    event: "playbackStatusUpdate",
    listener: (status: FilePlaybackStatus) => void,
  ): { remove(): void };
}

/** Own completion, load failure and resource release for the native file backend. */
export function playFile(player: FilePlayer, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // expo-audio 1.x does not report Android decoder errors. A local file that
    // never becomes loaded must still release its queue slot and temporary file.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, duration = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      subscription.remove();
      player.remove();
      if (error) reject(error);
      else resolve(duration);
    };
    const abort = () => finish(new Error("Playback stopped"));
    let loaded = false;
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.playbackState === "error" || status.playbackState === "failed") {
        finish(new Error("Audio file could not be decoded"));
      } else if (status.didJustFinish) {
        finish(undefined, status.duration);
      } else if (status.isLoaded && status.duration > 0 && !loaded) {
        loaded = true;
        clearTimeout(timeout);
        timeout = setTimeout(
          () => finish(new Error("Audio playback timed out")),
          (status.duration + 30) * 1000,
        );
      }
    });
    timeout = setTimeout(() => finish(new Error("Audio file could not be loaded")), 15000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      try {
        player.play();
      } catch (error) {
        finish(error);
      }
    }
  });
}

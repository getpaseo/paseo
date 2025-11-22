import { useMemo } from "react";

export interface AudioPlayerOptions {
  isDetecting?: () => boolean;
  isSpeaking?: () => boolean;
}

/**
 * Web shim for the native two-way audio player.
 * We currently don't support realtime voice playback on web.
 */
export function useAudioPlayer(_options?: AudioPlayerOptions) {
  return useMemo(
    () => ({
      play: async () => {
        console.warn("[AudioPlayer] Web playback is disabled");
        return 0;
      },
      stop: () => {
        console.warn("[AudioPlayer] Web playback stop noop");
      },
      isPlaying: () => false,
      clearQueue: () => {},
    }),
    []
  );
}

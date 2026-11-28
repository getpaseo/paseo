import type { AudioEngine, AudioEngineCallbacks, AudioEngineOptions } from "./audio-engine-types";

// Preserve the voice model's lifecycle without loading mobile-only Expo audio
// during app startup. Requests fail explicitly until a Linux audio backend exists.
export function createAudioEngine(
  _callbacks: AudioEngineCallbacks,
  _options?: AudioEngineOptions,
): AudioEngine {
  const unavailable = async (): Promise<never> => {
    throw new Error("Voice capture and playback are not available in the GPUI build yet.");
  };
  return {
    initialize: unavailable,
    startCapture: unavailable,
    play: unavailable,
    async destroy() {},
    async stopCapture() {},
    stop() {},
    clearQueue() {},
    isPlaying: () => false,
    isMuted: () => false,
    toggleMute() {
      throw new Error("Voice capture is not available in the GPUI build yet.");
    },
  };
}

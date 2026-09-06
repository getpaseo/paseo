import type { NativeAudioSessionModule } from "@/voice/native-audio-session";

export interface NativeAudioSubscription {
  remove(): void;
}

/** The native surface the audio engine uses, beyond what the session owns. */
export interface NativeAudioModule extends NativeAudioSessionModule {
  releaseAudioSession(): void;
  resumePlayback(): void;
  playPCMData(pcm: Uint8Array): void;
  stopPlayback(): void;
  getMicrophonePermissionsAsync(): Promise<{ granted: boolean }>;
  requestMicrophonePermissionsAsync(): Promise<{ granted: boolean }>;
  addExpoTwoWayAudioEventListener(
    event: string,
    listener: (payload: never) => void,
  ): NativeAudioSubscription;
}

/**
 * Loaded on demand: the package calls `requireNativeModule` at import time, which throws on a
 * binary that does not ship the native module.
 */
export function loadNativeAudioModule(): NativeAudioModule {
  return require("@getpaseo/expo-two-way-audio");
}

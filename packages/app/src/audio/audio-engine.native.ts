import type { AudioEngine, AudioEngineCallbacks, AudioEngineOptions } from "./audio-engine-types";

import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { playFile } from "./file-playback";
import { createNativeAudioEngine, type NativeAudioEngineDeps } from "./native-audio-engine";

// AVPlayer needs a file extension to recognize local encoded audio on iOS.
const FILE_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

let nextFileId = 0;

async function playEncodedAudio(
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
  context: { isCaptureActive(): boolean },
): Promise<number> {
  // Capture owns its audio session while active. File playback alone must not
  // initialize the microphone or the native two-way engine.
  if (!context.isCaptureActive()) {
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      interruptionMode: "duckOthers",
      interruptionModeAndroid: "duckOthers",
    });
  }
  if (signal.aborted) throw new Error("Playback stopped");
  const extension = FILE_EXTENSIONS[mimeType.split(";")[0].trim()] ?? "audio";
  const file = new File(Paths.cache, `paseo-audio-${Date.now()}-${nextFileId++}.${extension}`);
  try {
    file.write(bytes);
    const player = createAudioPlayer(file.uri, {
      updateInterval: 100,
      keepAudioSessionActive: context.isCaptureActive(),
    });
    return await playFile(player, signal);
  } finally {
    if (file.exists) file.delete();
  }
}

export function createAudioEngine(
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineOptions,
): AudioEngine {
  const native: NativeAudioEngineDeps["native"] = require("@getpaseo/expo-two-way-audio");
  return createNativeAudioEngine({ native, playEncodedAudio }, callbacks, options);
}

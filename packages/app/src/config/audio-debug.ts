export const AUDIO_DEBUG_ENABLED =
  typeof process !== "undefined" && process.env?.EXPO_PUBLIC_ENABLE_AUDIO_DEBUG === "1";

// Single source of truth for the dictation transcription prompt default.
// Imported by the daemon (fallback when no custom prompt is set) and the app
// (shown as the settings textarea placeholder).
export const DEFAULT_DICTATION_TRANSCRIPTION_PROMPT =
  "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.";

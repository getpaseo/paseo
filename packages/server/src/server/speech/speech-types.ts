import type {
  LocalSttModelId,
  LocalTtsModelId,
} from "./providers/local/sherpa/model-catalog.js";

export type SpeechProviderId = "openai" | "local";

export const DEFAULT_LOCAL_STT_MODEL: LocalSttModelId = "parakeet-tdt-0.6b-v3-int8";
export const DEFAULT_LOCAL_TTS_MODEL: LocalTtsModelId = "pocket-tts-onnx-int8";
export const DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

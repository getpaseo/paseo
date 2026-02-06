import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { STTConfig } from "./stt.js";
import type { TTSConfig } from "./tts.js";

export const DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const DEFAULT_OPENAI_TTS_MODEL = "tts-1";

export type OpenAiSpeechProviderConfig = {
  apiKey?: string;
  stt?: Partial<STTConfig> & { apiKey?: string };
  tts?: Partial<TTSConfig> & { apiKey?: string };
  realtimeTranscriptionModel?: string;
};

const OpenAiTtsVoiceSchema = z.enum([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);

const OpenAiTtsModelSchema = z.enum(["tts-1", "tts-1-hd"]);

const NumberLikeSchema = z.union([
  z.number(),
  z.string().trim().min(1),
]);

const OptionalFiniteNumberSchema = NumberLikeSchema
  .pipe(z.coerce.number().finite())
  .optional();

const OptionalTrimmedStringSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const OpenAiSpeechResolutionSchema = z.object({
  apiKey: OptionalTrimmedStringSchema,
  sttConfidenceThreshold: OptionalFiniteNumberSchema,
  sttModel: OptionalTrimmedStringSchema,
  ttsVoice: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(OpenAiTtsVoiceSchema)
    .default("alloy"),
  ttsModel: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(OpenAiTtsModelSchema)
    .default(DEFAULT_OPENAI_TTS_MODEL),
  realtimeTranscriptionModel: OptionalTrimmedStringSchema.default(
    DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL
  ),
});

export function resolveOpenAiSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): OpenAiSpeechProviderConfig | undefined {
  const parsed = OpenAiSpeechResolutionSchema.parse({
    apiKey: params.env.OPENAI_API_KEY ?? params.persisted.providers?.openai?.apiKey,
    sttConfidenceThreshold:
      params.env.STT_CONFIDENCE_THRESHOLD ??
      params.persisted.features?.dictation?.stt?.confidenceThreshold,
    sttModel:
      params.env.STT_MODEL ??
      (params.providers.voiceStt.provider === "openai"
        ? params.persisted.features?.voiceMode?.stt?.model
        : undefined) ??
      (params.providers.dictationStt.provider === "openai"
        ? params.persisted.features?.dictation?.stt?.model
        : undefined),
    ttsVoice:
      params.env.TTS_VOICE ??
      (params.providers.voiceTts.provider === "openai"
        ? params.persisted.features?.voiceMode?.tts?.voice
        : undefined) ??
      "alloy",
    ttsModel:
      params.env.TTS_MODEL ??
      (params.providers.voiceTts.provider === "openai"
        ? params.persisted.features?.voiceMode?.tts?.model
        : undefined) ??
      DEFAULT_OPENAI_TTS_MODEL,
    realtimeTranscriptionModel:
      params.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ??
      (params.providers.dictationStt.provider === "openai"
        ? params.persisted.features?.dictation?.stt?.model
        : undefined) ??
      DEFAULT_OPENAI_REALTIME_TRANSCRIPTION_MODEL,
  });

  if (!parsed.apiKey) {
    return undefined;
  }

  return {
    apiKey: parsed.apiKey,
    stt: {
      apiKey: parsed.apiKey,
      ...(parsed.sttConfidenceThreshold !== undefined
        ? { confidenceThreshold: parsed.sttConfidenceThreshold }
        : {}),
      ...(parsed.sttModel
        ? { model: parsed.sttModel }
        : {}),
    },
    tts: {
      apiKey: parsed.apiKey,
      voice: parsed.ttsVoice,
      model: parsed.ttsModel,
      responseFormat: "pcm",
    },
    realtimeTranscriptionModel: parsed.realtimeTranscriptionModel,
  };
}

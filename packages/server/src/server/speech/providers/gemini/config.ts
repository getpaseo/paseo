import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProvider, RequestedSpeechProviders } from "../../speech-types.js";

export const DEFAULT_GEMINI_STT_MODEL = "gemini-3.5-transcribe-live";
export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const DEFAULT_GEMINI_TTS_VOICE = "Kore";

const NonEmptyStringSchema = z.string().trim().min(1);

const GeminiSttConfigSchema = z.object({
  model: NonEmptyStringSchema.default(DEFAULT_GEMINI_STT_MODEL),
  language: NonEmptyStringSchema.optional(),
  mode: z.enum(["smart", "verbatim"]).default("smart"),
});

const GeminiTtsConfigSchema = z.object({
  model: NonEmptyStringSchema.default(DEFAULT_GEMINI_TTS_MODEL),
  voice: NonEmptyStringSchema.default(DEFAULT_GEMINI_TTS_VOICE),
});

export type GeminiSttConfig = z.infer<typeof GeminiSttConfigSchema>;
export type GeminiTtsConfig = z.infer<typeof GeminiTtsConfigSchema>;

export interface GeminiSpeechProviderConfig {
  apiKey: string;
  dictationStt: GeminiSttConfig;
  voiceStt: GeminiSttConfig;
  tts: GeminiTtsConfig;
}

function pickIfGemini<T>(provider: RequestedSpeechProvider, value: T | undefined): T | undefined {
  const isActive = provider.enabled !== false && provider.provider === "gemini";
  return isActive ? value : undefined;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function resolveGeminiSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): GeminiSpeechProviderConfig | undefined {
  const { env, persisted, providers } = params;
  const dictationSettings = persisted.features?.dictation?.stt;
  const voiceModeSettings = persisted.features?.voiceMode;
  const voiceSttSettings = voiceModeSettings?.stt;
  const voiceTtsSettings = voiceModeSettings?.tts;
  const dictationLanguage = firstNonEmpty([
    env.PASEO_DICTATION_LANGUAGE,
    dictationSettings?.language,
  ]);
  const dictationStt = GeminiSttConfigSchema.parse({
    model: pickIfGemini(providers.dictationStt, dictationSettings?.model),
    language: dictationLanguage,
    mode: pickIfGemini(providers.dictationStt, dictationSettings?.mode),
  });
  const voiceStt = GeminiSttConfigSchema.parse({
    model: pickIfGemini(providers.voiceStt, voiceSttSettings?.model),
    language: firstNonEmpty([
      env.PASEO_VOICE_LANGUAGE,
      pickIfGemini(providers.voiceStt, voiceSttSettings?.language),
      dictationLanguage,
    ]),
    mode: pickIfGemini(providers.voiceStt, voiceSttSettings?.mode),
  });
  const tts = GeminiTtsConfigSchema.parse({
    model: pickIfGemini(providers.voiceTts, voiceTtsSettings?.model),
    voice: pickIfGemini(providers.voiceTts, voiceTtsSettings?.voice),
  });
  const apiKey = firstNonEmpty([persisted.providers?.gemini?.apiKey, env.GEMINI_API_KEY]);

  return apiKey ? { apiKey, dictationStt, voiceStt, tts } : undefined;
}

import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { STTConfig } from "./stt.js";
import type { TTSConfig } from "./tts.js";

export const DEFAULT_OPENAI_TTS_MODEL = "tts-1";

export interface OpenAiSpeechProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  stt?: Partial<STTConfig> & { apiKey?: string };
  tts?: Partial<TTSConfig> & { apiKey?: string };
}

const OpenAiTtsVoiceSchema = z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

const OpenAiTtsModelSchema = z.enum(["tts-1", "tts-1-hd"]);

const NumberLikeSchema = z.union([z.number(), z.string().trim().min(1)]);

const OptionalFiniteNumberSchema = NumberLikeSchema.pipe(
  z.coerce.number<string | number>().finite(),
).optional();

const OptionalTrimmedStringSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const OpenAiSpeechResolutionSchema = z.object({
  apiKey: OptionalTrimmedStringSchema,
  baseUrl: OptionalTrimmedStringSchema,
  sttConfidenceThreshold: OptionalFiniteNumberSchema,
  sttModel: OptionalTrimmedStringSchema,
  ttsVoice: z.string().trim().toLowerCase().pipe(OpenAiTtsVoiceSchema).default("alloy"),
  ttsModel: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(OpenAiTtsModelSchema)
    .default(DEFAULT_OPENAI_TTS_MODEL),
});

function isOpenAiProviderActive(provider: { enabled?: boolean; provider: string }): boolean {
  return provider.enabled !== false && provider.provider === "openai";
}

function pickIfOpenAi<T>(
  provider: { enabled?: boolean; provider: string },
  value: T | undefined,
): T | undefined {
  return isOpenAiProviderActive(provider) ? value : undefined;
}

function firstDefined<T>(values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function buildOpenAiSttInput(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): Record<string, unknown> {
  const { env, persisted, providers } = params;
  return {
    sttConfidenceThreshold: firstDefined<string | number>([
      env.STT_CONFIDENCE_THRESHOLD,
      persisted.features?.dictation?.stt?.confidenceThreshold,
    ]),
    sttModel: firstDefined<string>([
      env.STT_MODEL,
      pickIfOpenAi(providers.voiceStt, persisted.features?.voiceMode?.stt?.model),
      pickIfOpenAi(providers.dictationStt, persisted.features?.dictation?.stt?.model),
    ]),
  };
}

function buildOpenAiTtsInput(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): Record<string, unknown> {
  const { env, persisted, providers } = params;
  return {
    ttsVoice: firstDefined<string>([
      env.TTS_VOICE,
      pickIfOpenAi(providers.voiceTts, persisted.features?.voiceMode?.tts?.voice),
      "alloy",
    ]),
    ttsModel: firstDefined<string>([
      env.TTS_MODEL,
      pickIfOpenAi(providers.voiceTts, persisted.features?.voiceMode?.tts?.model),
      DEFAULT_OPENAI_TTS_MODEL,
    ]),
  };
}

function buildOpenAiResolutionInput(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): Record<string, unknown> {
  return {
    apiKey: firstDefined<string>([
      params.persisted.providers?.openai?.voice?.apiKey,
      params.env.OPENAI_VOICE_API_KEY,
      params.persisted.providers?.openai?.apiKey,
      params.env.OPENAI_API_KEY,
    ]),
    baseUrl: firstDefined<string>([
      params.persisted.providers?.openai?.voice?.baseUrl,
      params.env.OPENAI_VOICE_BASE_URL,
      params.persisted.providers?.openai?.baseUrl,
      params.env.OPENAI_BASE_URL,
    ]),
    ...buildOpenAiSttInput(params),
    ...buildOpenAiTtsInput(params),
  };
}

export function resolveOpenAiSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): OpenAiSpeechProviderConfig | undefined {
  const parsed = OpenAiSpeechResolutionSchema.parse(buildOpenAiResolutionInput(params));

  if (!parsed.apiKey) {
    return undefined;
  }

  return {
    apiKey: parsed.apiKey,
    ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
    stt: {
      apiKey: parsed.apiKey,
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      ...(parsed.sttConfidenceThreshold !== undefined
        ? { confidenceThreshold: parsed.sttConfidenceThreshold }
        : {}),
      ...(parsed.sttModel ? { model: parsed.sttModel } : {}),
    },
    tts: {
      apiKey: parsed.apiKey,
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      voice: parsed.ttsVoice,
      model: parsed.ttsModel,
      responseFormat: "pcm",
    },
  };
}

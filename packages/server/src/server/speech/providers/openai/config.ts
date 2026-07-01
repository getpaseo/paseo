import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { STTConfig } from "./stt.js";
import type { TTSConfig } from "./tts.js";

export const DEFAULT_OPENAI_TTS_MODEL = "tts-1";

export interface OpenAiSpeechProviderConfig {
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

// Endpoint credentials only — plain trimmed strings, so this never throws on a
// malformed value. The STT/TTS option groups parse separately and only for the
// endpoint that is actually configured, so a stale env var for an unused endpoint
// (e.g. a leftover TTS_VOICE in an STT-only setup) can't break the other one.
const OpenAiEndpointKeysSchema = z.object({
  sttApiKey: OptionalTrimmedStringSchema,
  sttBaseUrl: OptionalTrimmedStringSchema,
  ttsApiKey: OptionalTrimmedStringSchema,
  ttsBaseUrl: OptionalTrimmedStringSchema,
});

const OpenAiSttOptionsSchema = z.object({
  sttConfidenceThreshold: OptionalFiniteNumberSchema,
  sttModel: OptionalTrimmedStringSchema,
});

const OpenAiTtsOptionsSchema = z.object({
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
    if (value === undefined || value === null) {
      continue;
    }
    // Empty/whitespace env vars (e.g. a copied .env.example with OPENAI_STT_API_KEY=)
    // must not shadow a later fallback such as OPENAI_API_KEY.
    if (typeof value === "string" && value.trim().length === 0) {
      continue;
    }
    return value;
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
  const { env } = params;
  const openai = params.persisted.providers?.openai;
  return {
    sttApiKey: firstDefined<string>([
      openai?.stt?.apiKey,
      env.OPENAI_STT_API_KEY,
      openai?.apiKey,
      env.OPENAI_API_KEY,
    ]),
    sttBaseUrl: firstDefined<string>([
      openai?.stt?.baseUrl,
      env.OPENAI_STT_BASE_URL,
      openai?.baseUrl,
      env.OPENAI_BASE_URL,
    ]),
    ttsApiKey: firstDefined<string>([
      openai?.tts?.apiKey,
      env.OPENAI_TTS_API_KEY,
      openai?.apiKey,
      env.OPENAI_API_KEY,
    ]),
    ttsBaseUrl: firstDefined<string>([
      openai?.tts?.baseUrl,
      env.OPENAI_TTS_BASE_URL,
      openai?.baseUrl,
      env.OPENAI_BASE_URL,
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
  const input = buildOpenAiResolutionInput(params);
  const keys = OpenAiEndpointKeysSchema.parse(input);

  if (!keys.sttApiKey && !keys.ttsApiKey) {
    return undefined;
  }

  return {
    ...(keys.sttApiKey ? { stt: buildSttConfig(keys.sttApiKey, keys.sttBaseUrl, input) } : {}),
    ...(keys.ttsApiKey ? { tts: buildTtsConfig(keys.ttsApiKey, keys.ttsBaseUrl, input) } : {}),
  };
}

function buildSttConfig(
  apiKey: string,
  baseUrl: string | undefined,
  input: Record<string, unknown>,
): OpenAiSpeechProviderConfig["stt"] {
  const options = OpenAiSttOptionsSchema.parse(input);
  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.sttConfidenceThreshold !== undefined
      ? { confidenceThreshold: options.sttConfidenceThreshold }
      : {}),
    ...(options.sttModel ? { model: options.sttModel } : {}),
  };
}

function buildTtsConfig(
  apiKey: string,
  baseUrl: string | undefined,
  input: Record<string, unknown>,
): OpenAiSpeechProviderConfig["tts"] {
  const options = OpenAiTtsOptionsSchema.parse(input);
  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    voice: options.ttsVoice,
    model: options.ttsModel,
    responseFormat: "pcm",
  };
}

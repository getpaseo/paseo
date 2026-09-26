import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { STTConfig } from "./stt.js";
import type { TTSConfig } from "./tts.js";

export const DEFAULT_OPENAI_TTS_MODEL = "tts-1";

export const OpenAiSpeechEndpointSchema = z
  .object({
    auth: z.enum(["apiKey", "none"]).optional(),
    apiKey: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((endpoint, ctx) => {
    if (endpoint.auth !== "none") return;
    const url = endpoint.baseUrl ? URL.parse(endpoint.baseUrl) : null;
    const isLoopback = url && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
      !url ||
      !isLoopback ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "auth: none requires an explicit HTTP(S) loopback baseUrl",
      });
    }
    if (endpoint.apiKey) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "Do not set apiKey with auth: none",
      });
    }
  });

export type OpenAiSpeechEndpointConfig = z.infer<typeof OpenAiSpeechEndpointSchema>;

export interface OpenAiSpeechProviderConfig {
  stt?: Partial<STTConfig> & { apiKey?: string };
  tts?: Partial<TTSConfig> & { apiKey?: string };
}

const NumberLikeSchema = z.union([z.number(), z.string().trim().min(1)]);

const OptionalFiniteNumberSchema = NumberLikeSchema.pipe(
  z.coerce.number<string | number>().finite(),
).optional();

const OptionalTrimmedStringSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const OpenAiSttOptionsSchema = z.object({
  sttConfidenceThreshold: OptionalFiniteNumberSchema,
  sttModel: OptionalTrimmedStringSchema,
});

const OpenAiTtsOptionsSchema = z.object({
  ttsVoice: z.string().trim().min(1).default("alloy"),
  ttsModel: z.string().trim().min(1).default(DEFAULT_OPENAI_TTS_MODEL),
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

function resolveEndpoint(params: {
  endpoint: OpenAiSpeechEndpointConfig | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  fallbackApiKey: string | undefined;
  fallbackBaseUrl: string | undefined;
}): OpenAiSpeechEndpointConfig {
  const { endpoint } = params;
  // No-auth endpoints are self-contained. Neither credentials nor the URL may
  // be inherited from cloud configuration or deployment environment variables.
  if (endpoint?.auth === "none") return OpenAiSpeechEndpointSchema.parse(endpoint);
  return OpenAiSpeechEndpointSchema.parse({
    auth: endpoint?.auth,
    apiKey: firstDefined([endpoint?.apiKey, params.apiKey, params.fallbackApiKey]),
    baseUrl: firstDefined([endpoint?.baseUrl, params.baseUrl, params.fallbackBaseUrl]),
  });
}

export function isOpenAiSpeechEndpointConfigured(
  endpoint: OpenAiSpeechEndpointConfig | undefined,
): endpoint is OpenAiSpeechEndpointConfig {
  return Boolean(endpoint && (endpoint.auth === "none" || endpoint.apiKey));
}

export function resolveOpenAiSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): OpenAiSpeechProviderConfig | undefined {
  const { env } = params;
  const openai = params.persisted.providers?.openai;
  const fallbackApiKey = firstDefined([openai?.apiKey, env.OPENAI_API_KEY]);
  const fallbackBaseUrl = firstDefined([openai?.baseUrl, env.OPENAI_BASE_URL]);
  const stt = resolveEndpoint({
    endpoint: openai?.stt,
    apiKey: env.OPENAI_STT_API_KEY,
    baseUrl: env.OPENAI_STT_BASE_URL,
    fallbackApiKey,
    fallbackBaseUrl,
  });
  const tts = resolveEndpoint({
    endpoint: openai?.tts,
    apiKey: env.OPENAI_TTS_API_KEY,
    baseUrl: env.OPENAI_TTS_BASE_URL,
    fallbackApiKey,
    fallbackBaseUrl,
  });
  const hasStt = isOpenAiSpeechEndpointConfigured(stt);
  const hasTts = isOpenAiSpeechEndpointConfigured(tts);
  if (!hasStt && !hasTts) return undefined;
  return {
    ...(hasStt ? { stt: buildSttConfig(stt, buildOpenAiSttInput(params)) } : {}),
    ...(hasTts ? { tts: buildTtsConfig(tts, buildOpenAiTtsInput(params)) } : {}),
  };
}

function buildSttConfig(
  endpoint: OpenAiSpeechEndpointConfig,
  input: Record<string, unknown>,
): OpenAiSpeechProviderConfig["stt"] {
  const options = OpenAiSttOptionsSchema.parse(input);
  return {
    ...endpoint,
    ...(options.sttConfidenceThreshold !== undefined
      ? { confidenceThreshold: options.sttConfidenceThreshold }
      : {}),
    ...(options.sttModel ? { model: options.sttModel } : {}),
  };
}

function buildTtsConfig(
  endpoint: OpenAiSpeechEndpointConfig,
  input: Record<string, unknown>,
): OpenAiSpeechProviderConfig["tts"] {
  const options = OpenAiTtsOptionsSchema.parse(input);
  return {
    ...endpoint,
    voice: options.ttsVoice,
    model: options.ttsModel,
    responseFormat: "pcm",
  };
}

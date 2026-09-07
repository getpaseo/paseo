import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { MiniMaxTTSConfig } from "./tts.js";

export const MINIMAX_TTS_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
] as const;

export const MINIMAX_TTS_REGIONS = ["global_en", "cn_zh"] as const;
export const MINIMAX_TTS_AUDIO_FORMATS = ["mp3", "wav", "flac", "pcm"] as const;

export const DEFAULT_MINIMAX_TTS_MODEL = "speech-2.8-hd";
export const DEFAULT_MINIMAX_TTS_REGION = "global_en";

const MiniMaxTtsModelSchema = z.enum(MINIMAX_TTS_MODELS);
const MiniMaxTtsRegionSchema = z.enum(MINIMAX_TTS_REGIONS);
const MiniMaxTtsAudioFormatSchema = z.enum(MINIMAX_TTS_AUDIO_FORMATS);

const OptionalTrimmedStringSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const MiniMaxTtsOptionsSchema = z.object({
  model: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(MiniMaxTtsModelSchema)
    .default(DEFAULT_MINIMAX_TTS_MODEL),
  region: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(MiniMaxTtsRegionSchema)
    .default(DEFAULT_MINIMAX_TTS_REGION),
  format: z.string().trim().toLowerCase().pipe(MiniMaxTtsAudioFormatSchema).default("mp3"),
  voiceId: OptionalTrimmedStringSchema,
});

export interface MiniMaxSpeechProviderConfig {
  tts?: Partial<MiniMaxTTSConfig> & { apiKey?: string };
}

interface MiniMaxTtsSources {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  provider: NonNullable<NonNullable<PersistedConfig["providers"]>["minimax"]> | undefined;
  selectedTts: boolean;
}

function firstDefined<T>(values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    return value;
  }
  return undefined;
}

function resolveMiniMaxTtsOptions(sources: MiniMaxTtsSources) {
  const { env, persisted, provider, selectedTts } = sources;
  return MiniMaxTtsOptionsSchema.parse({
    model: firstDefined([
      env.MINIMAX_TTS_MODEL,
      selectedTts ? persisted.features?.voiceMode?.tts?.model : undefined,
      DEFAULT_MINIMAX_TTS_MODEL,
    ]),
    region: firstDefined([env.MINIMAX_REGION, provider?.region, DEFAULT_MINIMAX_TTS_REGION]),
    format: firstDefined([env.MINIMAX_TTS_FORMAT, "mp3"]),
    voiceId: firstDefined([
      env.MINIMAX_TTS_VOICE,
      selectedTts ? persisted.features?.voiceMode?.tts?.voice : undefined,
    ]),
  });
}

export function resolveMiniMaxSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): MiniMaxSpeechProviderConfig | undefined {
  const { env, persisted, providers } = params;
  const provider = persisted.providers?.minimax;
  const apiKey = firstDefined([provider?.tts?.apiKey, provider?.apiKey, env.MINIMAX_API_KEY]);

  if (!apiKey) return undefined;

  const selectedTts =
    providers.voiceTts.enabled !== false && providers.voiceTts.provider === "minimax";
  const options = resolveMiniMaxTtsOptions({ env, persisted, provider, selectedTts });
  const baseUrl = firstDefined([
    provider?.tts?.baseUrl,
    provider?.baseUrl,
    env.MINIMAX_TTS_BASE_URL,
    env.MINIMAX_BASE_URL,
  ]);

  return {
    tts: {
      apiKey,
      model: options.model,
      region: options.region,
      responseFormat: options.format,
      ...(options.voiceId ? { voiceId: options.voiceId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

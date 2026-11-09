import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { STTConfig } from "./stt.js";
import type { TTSConfig } from "./tts.js";

export const DEFAULT_OPENAI_TTS_MODEL = "tts-1";
export type OpenAiSttFeature = "dictation" | "voiceMode";

export interface OpenAiSpeechProviderConfig {
  dictationStt?: Partial<STTConfig>;
  stt?: Partial<STTConfig>;
  tts?: Partial<TTSConfig>;
}

const OptionalFiniteNumberSchema = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number<string | number>().finite())
  .optional();

function firstString(...values: (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value) => Boolean(value));
}

type Features = NonNullable<PersistedConfig["features"]>;
type SttSite = NonNullable<NonNullable<Features["dictation"]>["stt"]>;
type TtsSite = NonNullable<NonNullable<Features["voiceMode"]>["tts"]>;

function resolveStt(
  site: SttSite | undefined,
  env: NodeJS.ProcessEnv,
): Partial<STTConfig> | undefined {
  const config = site?.provider === "openai" ? site : undefined;
  const apiKey = firstString(config?.apiKey, env.OPENAI_STT_API_KEY, env.OPENAI_API_KEY);
  if (!apiKey) return undefined;
  const baseUrl = firstString(config?.baseUrl, env.OPENAI_STT_BASE_URL, env.OPENAI_BASE_URL);
  const model = firstString(env.STT_MODEL, config?.model);
  const confidenceThreshold = OptionalFiniteNumberSchema.parse(
    firstString(env.STT_CONFIDENCE_THRESHOLD) ?? config?.confidenceThreshold,
  );
  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(confidenceThreshold !== undefined ? { confidenceThreshold } : {}),
  };
}

function resolveTts(
  site: TtsSite | undefined,
  env: NodeJS.ProcessEnv,
): Partial<TTSConfig> | undefined {
  const config = site?.provider === "openai" ? site : undefined;
  const apiKey = firstString(config?.apiKey, env.OPENAI_TTS_API_KEY, env.OPENAI_API_KEY);
  if (!apiKey) return undefined;
  const baseUrl = firstString(config?.baseUrl, env.OPENAI_TTS_BASE_URL, env.OPENAI_BASE_URL);
  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model: firstString(env.TTS_MODEL, config?.model) ?? DEFAULT_OPENAI_TTS_MODEL,
    voice: firstString(env.TTS_VOICE, config?.voice) ?? "alloy",
    responseFormat: "pcm",
  };
}

export function resolveOpenAiSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): OpenAiSpeechProviderConfig | undefined {
  const { env, persisted } = params;
  const dictationStt = resolveStt(persisted.features?.dictation?.stt, env);
  const stt = resolveStt(persisted.features?.voiceMode?.stt, env);
  const tts = resolveTts(persisted.features?.voiceMode?.tts, env);
  if (!dictationStt && !stt && !tts) return undefined;
  return {
    ...(dictationStt ? { dictationStt } : {}),
    ...(stt ? { stt } : {}),
    ...(tts ? { tts } : {}),
  };
}

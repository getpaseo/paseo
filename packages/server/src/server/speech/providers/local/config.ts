import path from "node:path";

import { z } from "zod";

import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  LocalTtsModelIdSchema,
  type LocalSpeechModelId,
  type LocalSttModelId,
  type LocalTtsModelId,
} from "./models.js";

export interface LocalSpeechModelConfig {
  dictationStt: LocalSttModelId;
  voiceStt: LocalSttModelId;
  voiceTts: LocalTtsModelId;
  voiceTtsSpeakerId?: number;
  voiceTtsSpeed?: number;
}

export interface LocalSpeechProviderConfig {
  modelsDir: string;
  models: LocalSpeechModelConfig;
}

export interface ResolvedLocalSpeechConfig {
  local: LocalSpeechProviderConfig | undefined;
}

export type { LocalSpeechModelId, LocalSttModelId, LocalTtsModelId };

const DEFAULT_LOCAL_MODELS_SUBDIR = path.join("models", "local-speech");

const NumberLikeSchema = z.union([z.number(), z.string().trim().min(1)]);

const OptionalFiniteNumberSchema = NumberLikeSchema.pipe(z.coerce.number().finite()).optional();

const OptionalIntegerSchema = NumberLikeSchema.pipe(z.coerce.number().int()).optional();

const LocalSpeechResolutionSchema = z.object({
  includeProviderConfig: z.boolean(),
  modelsDir: z.string().trim().min(1),
  dictationLocalSttModel: LocalSttModelIdSchema.default(DEFAULT_LOCAL_STT_MODEL),
  voiceLocalSttModel: LocalSttModelIdSchema.default(DEFAULT_LOCAL_STT_MODEL),
  voiceLocalTtsModel: LocalTtsModelIdSchema.default(DEFAULT_LOCAL_TTS_MODEL),
  voiceLocalTtsSpeakerId: OptionalIntegerSchema,
  voiceLocalTtsSpeed: OptionalFiniteNumberSchema,
});

function persistedLocalFeatureModel(
  provider: RequestedSpeechProviders[keyof RequestedSpeechProviders]["provider"],
  enabled: boolean | undefined,
  model: string | undefined,
): string | undefined {
  if (provider !== "local" || enabled === false) {
    return undefined;
  }
  return model;
}

function shouldIncludeLocalProviderConfig(params: {
  providers: RequestedSpeechProviders;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): boolean {
  const localRequestedByFeature =
    (params.providers.dictationStt.enabled !== false &&
      params.providers.dictationStt.provider === "local") ||
    (params.providers.voiceStt.enabled !== false &&
      params.providers.voiceStt.provider === "local") ||
    (params.providers.voiceTts.enabled !== false && params.providers.voiceTts.provider === "local");

  return (
    localRequestedByFeature ||
    params.env.PASEO_LOCAL_MODELS_DIR !== undefined ||
    params.persisted.providers?.local?.modelsDir !== undefined
  );
}

function firstDefinedValue<T>(values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function buildLocalSpeechResolutionInput(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
  includeProviderConfig: boolean;
}): Record<string, unknown> {
  const { paseoHome, env, persisted, providers, includeProviderConfig } = params;
  return {
    includeProviderConfig,
    modelsDir: firstDefinedValue<string>([
      env.PASEO_LOCAL_MODELS_DIR,
      persisted.providers?.local?.modelsDir,
      path.join(paseoHome, DEFAULT_LOCAL_MODELS_SUBDIR),
    ]),
    dictationLocalSttModel: firstDefinedValue<string>([
      env.PASEO_DICTATION_LOCAL_STT_MODEL,
      persistedLocalFeatureModel(
        providers.dictationStt.provider,
        providers.dictationStt.enabled,
        persisted.features?.dictation?.stt?.model,
      ),
      DEFAULT_LOCAL_STT_MODEL,
    ]),
    voiceLocalSttModel: firstDefinedValue<string>([
      env.PASEO_VOICE_LOCAL_STT_MODEL,
      persistedLocalFeatureModel(
        providers.voiceStt.provider,
        providers.voiceStt.enabled,
        persisted.features?.voiceMode?.stt?.model,
      ),
      DEFAULT_LOCAL_STT_MODEL,
    ]),
    voiceLocalTtsModel: firstDefinedValue<string>([
      env.PASEO_VOICE_LOCAL_TTS_MODEL,
      persistedLocalFeatureModel(
        providers.voiceTts.provider,
        providers.voiceTts.enabled,
        persisted.features?.voiceMode?.tts?.model,
      ),
      DEFAULT_LOCAL_TTS_MODEL,
    ]),
    voiceLocalTtsSpeakerId: firstDefinedValue<string | number>([
      env.PASEO_VOICE_LOCAL_TTS_SPEAKER_ID,
      persisted.features?.voiceMode?.tts?.speakerId,
    ]),
    voiceLocalTtsSpeed: firstDefinedValue<string | number>([
      env.PASEO_VOICE_LOCAL_TTS_SPEED,
      persisted.features?.voiceMode?.tts?.speed,
    ]),
  };
}

export function resolveLocalSpeechConfig(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): ResolvedLocalSpeechConfig {
  const includeProviderConfig = shouldIncludeLocalProviderConfig(params);
  const parsed = LocalSpeechResolutionSchema.parse(
    buildLocalSpeechResolutionInput({ ...params, includeProviderConfig }),
  );

  const resolvedVoiceTtsSpeakerId =
    parsed.voiceLocalTtsSpeakerId ??
    (parsed.voiceLocalTtsModel === "kokoro-en-v0_19" ? 0 : undefined);

  return {
    local: parsed.includeProviderConfig
      ? {
          modelsDir: parsed.modelsDir,
          models: {
            dictationStt: parsed.dictationLocalSttModel,
            voiceStt: parsed.voiceLocalSttModel,
            voiceTts: parsed.voiceLocalTtsModel,
            ...(resolvedVoiceTtsSpeakerId !== undefined
              ? { voiceTtsSpeakerId: resolvedVoiceTtsSpeakerId }
              : {}),
            ...(parsed.voiceLocalTtsSpeed !== undefined
              ? { voiceTtsSpeed: parsed.voiceLocalTtsSpeed }
              : {}),
          },
        }
      : undefined,
  };
}

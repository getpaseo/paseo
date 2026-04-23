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

export function resolveLocalSpeechConfig(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
}): ResolvedLocalSpeechConfig {
  const includeProviderConfig = shouldIncludeLocalProviderConfig(params);

  const parsed = LocalSpeechResolutionSchema.parse({
    includeProviderConfig,
    modelsDir:
      params.env.PASEO_LOCAL_MODELS_DIR ??
      params.persisted.providers?.local?.modelsDir ??
      path.join(params.paseoHome, DEFAULT_LOCAL_MODELS_SUBDIR),
    dictationLocalSttModel:
      params.env.PASEO_DICTATION_LOCAL_STT_MODEL ??
      persistedLocalFeatureModel(
        params.providers.dictationStt.provider,
        params.providers.dictationStt.enabled,
        params.persisted.features?.dictation?.stt?.model,
      ) ??
      DEFAULT_LOCAL_STT_MODEL,
    voiceLocalSttModel:
      params.env.PASEO_VOICE_LOCAL_STT_MODEL ??
      persistedLocalFeatureModel(
        params.providers.voiceStt.provider,
        params.providers.voiceStt.enabled,
        params.persisted.features?.voiceMode?.stt?.model,
      ) ??
      DEFAULT_LOCAL_STT_MODEL,
    voiceLocalTtsModel:
      params.env.PASEO_VOICE_LOCAL_TTS_MODEL ??
      persistedLocalFeatureModel(
        params.providers.voiceTts.provider,
        params.providers.voiceTts.enabled,
        params.persisted.features?.voiceMode?.tts?.model,
      ) ??
      DEFAULT_LOCAL_TTS_MODEL,
    voiceLocalTtsSpeakerId:
      params.env.PASEO_VOICE_LOCAL_TTS_SPEAKER_ID ??
      params.persisted.features?.voiceMode?.tts?.speakerId,
    voiceLocalTtsSpeed:
      params.env.PASEO_VOICE_LOCAL_TTS_SPEED ?? params.persisted.features?.voiceMode?.tts?.speed,
  });

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

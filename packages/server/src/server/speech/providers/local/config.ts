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

export type LocalSpeechModelConfig = {
  dictationStt: LocalSttModelId;
  voiceStt: LocalSttModelId;
  voiceTts: LocalTtsModelId;
  voiceTtsSpeakerId?: number;
  voiceTtsSpeed?: number;
};

export type LocalSpeechProviderConfig = {
  modelsDir: string;
  autoDownload?: boolean;
  models: LocalSpeechModelConfig;
};

export type ResolvedLocalSpeechConfig = {
  local: LocalSpeechProviderConfig | undefined;
};

export type { LocalSpeechModelId, LocalSttModelId, LocalTtsModelId };

const DEFAULT_LOCAL_MODELS_SUBDIR = path.join("models", "local-speech");

const BooleanStringSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["1", "0", "true", "false", "yes", "no"]))
  .transform((value) => value === "1" || value === "true" || value === "yes");

const OptionalBooleanFlagSchema = z
  .union([z.boolean(), BooleanStringSchema])
  .optional();

const NumberLikeSchema = z.union([
  z.number(),
  z.string().trim().min(1),
]);

const OptionalFiniteNumberSchema = NumberLikeSchema
  .pipe(z.coerce.number().finite())
  .optional();

const OptionalIntegerSchema = NumberLikeSchema
  .pipe(z.coerce.number().int())
  .optional();

const LocalSpeechResolutionSchema = z.object({
  includeProviderConfig: z.boolean(),
  modelsDir: z.string().trim().min(1),
  autoDownload: OptionalBooleanFlagSchema.default(true),
  dictationLocalSttModel: LocalSttModelIdSchema.default(DEFAULT_LOCAL_STT_MODEL),
  voiceLocalSttModel: LocalSttModelIdSchema.default(DEFAULT_LOCAL_STT_MODEL),
  voiceLocalTtsModel: LocalTtsModelIdSchema.default(DEFAULT_LOCAL_TTS_MODEL),
  voiceLocalTtsSpeakerId: OptionalIntegerSchema,
  voiceLocalTtsSpeed: OptionalFiniteNumberSchema,
});

function persistedLocalFeatureModel(
  provider: RequestedSpeechProviders[keyof RequestedSpeechProviders]["provider"],
  model: string | undefined
): string | undefined {
  if (provider !== "local") {
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
    params.providers.dictationStt.provider === "local" ||
    params.providers.voiceStt.provider === "local" ||
    params.providers.voiceTts.provider === "local";

  return (
    localRequestedByFeature ||
    params.env.PASEO_LOCAL_MODELS_DIR !== undefined ||
    params.persisted.providers?.local !== undefined
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
    autoDownload:
      params.env.PASEO_LOCAL_AUTO_DOWNLOAD ??
      params.persisted.providers?.local?.autoDownload,
    dictationLocalSttModel:
      params.env.PASEO_DICTATION_LOCAL_STT_MODEL ??
      persistedLocalFeatureModel(
        params.providers.dictationStt.provider,
        params.persisted.features?.dictation?.stt?.model
      ) ??
      DEFAULT_LOCAL_STT_MODEL,
    voiceLocalSttModel:
      params.env.PASEO_VOICE_LOCAL_STT_MODEL ??
      persistedLocalFeatureModel(
        params.providers.voiceStt.provider,
        params.persisted.features?.voiceMode?.stt?.model
      ) ??
      DEFAULT_LOCAL_STT_MODEL,
    voiceLocalTtsModel:
      params.env.PASEO_VOICE_LOCAL_TTS_MODEL ??
      persistedLocalFeatureModel(
        params.providers.voiceTts.provider,
        params.persisted.features?.voiceMode?.tts?.model
      ) ??
      DEFAULT_LOCAL_TTS_MODEL,
    voiceLocalTtsSpeakerId:
      params.env.PASEO_VOICE_LOCAL_TTS_SPEAKER_ID ??
      params.persisted.features?.voiceMode?.tts?.speakerId,
    voiceLocalTtsSpeed:
      params.env.PASEO_VOICE_LOCAL_TTS_SPEED ??
      params.persisted.features?.voiceMode?.tts?.speed,
  });

  return {
    local:
      parsed.includeProviderConfig
        ? {
            modelsDir: parsed.modelsDir,
            autoDownload: parsed.autoDownload,
            models: {
              dictationStt: parsed.dictationLocalSttModel,
              voiceStt: parsed.voiceLocalSttModel,
              voiceTts: parsed.voiceLocalTtsModel,
              ...(parsed.voiceLocalTtsSpeakerId !== undefined
                ? { voiceTtsSpeakerId: parsed.voiceLocalTtsSpeakerId }
                : {}),
              ...(parsed.voiceLocalTtsSpeed !== undefined
                ? { voiceTtsSpeed: parsed.voiceLocalTtsSpeed }
                : {}),
            },
          }
        : undefined,
  };
}

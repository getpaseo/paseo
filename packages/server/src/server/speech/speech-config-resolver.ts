import { z } from "zod";

import type { PersistedConfig } from "../persisted-config.js";
import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import { resolveLocalSpeechConfig } from "./providers/local/config.js";
import { resolveOpenAiSpeechConfig } from "./providers/openai/config.js";
import {
  SpeechProviderIdSchema,
  type RequestedSpeechProvider,
  type RequestedSpeechProviders,
} from "./speech-types.js";

const OptionalSpeechProviderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(SpeechProviderIdSchema)
  .optional();

const RequestedSpeechProvidersSchema = z.object({
  dictationStt: OptionalSpeechProviderSchema.default("local"),
  voiceStt: OptionalSpeechProviderSchema.default("local"),
  voiceTts: OptionalSpeechProviderSchema.default("local"),
});

function resolveRequestedSpeechProviders(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): RequestedSpeechProviders {
  const resolveFeatureProvider = (
    configuredValue: string | undefined,
    parsedValue: z.infer<typeof SpeechProviderIdSchema>
  ): RequestedSpeechProvider => ({
    provider: parsedValue,
    explicit: configuredValue !== undefined,
  });

  const dictationSttProviderFromConfig =
    params.env.PASEO_DICTATION_STT_PROVIDER ??
    params.persisted.features?.dictation?.stt?.provider;
  const voiceSttProviderFromConfig =
    params.env.PASEO_VOICE_STT_PROVIDER ??
    params.persisted.features?.voiceMode?.stt?.provider;
  const voiceTtsProviderFromConfig =
    params.env.PASEO_VOICE_TTS_PROVIDER ??
    params.persisted.features?.voiceMode?.tts?.provider;

  const parsed = RequestedSpeechProvidersSchema.parse({
    dictationStt: dictationSttProviderFromConfig ?? "local",
    voiceStt: voiceSttProviderFromConfig ?? "local",
    voiceTts: voiceTtsProviderFromConfig ?? "local",
  });

  return {
    dictationStt: resolveFeatureProvider(
      dictationSttProviderFromConfig,
      parsed.dictationStt
    ),
    voiceStt: resolveFeatureProvider(
      voiceSttProviderFromConfig,
      parsed.voiceStt
    ),
    voiceTts: resolveFeatureProvider(
      voiceTtsProviderFromConfig,
      parsed.voiceTts
    ),
  };
}

export function resolveSpeechConfig(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): {
  openai: PaseoOpenAIConfig | undefined;
  speech: PaseoSpeechConfig;
} {
  const providers = resolveRequestedSpeechProviders({
    env: params.env,
    persisted: params.persisted,
  });

  const local = resolveLocalSpeechConfig({
    paseoHome: params.paseoHome,
    env: params.env,
    persisted: params.persisted,
    providers,
  });

  const openai = resolveOpenAiSpeechConfig({
    env: params.env,
    persisted: params.persisted,
    providers,
  });

  return {
    openai,
    speech: {
      providers,
      ...(local.local
        ? { local: local.local }
        : {}),
      localModels: {
        dictationStt: local.dictationLocalSttModel,
        voiceStt: local.voiceLocalSttModel,
        voiceTts: local.voiceLocalTtsModel,
        ...(local.voiceLocalTtsSpeakerId !== undefined
          ? { voiceTtsSpeakerId: local.voiceLocalTtsSpeakerId }
          : {}),
        ...(local.voiceLocalTtsSpeed !== undefined
          ? { voiceTtsSpeed: local.voiceLocalTtsSpeed }
          : {}),
      },
    },
  };
}

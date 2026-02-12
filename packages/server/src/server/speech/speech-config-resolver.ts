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

const OptionalBooleanFlagSchema = z
  .union([z.boolean(), z.string().trim().toLowerCase()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === undefined) {
      return undefined;
    }
    if (["1", "true", "yes", "y", "on"].includes(value)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(value)) {
      return false;
    }
    return undefined;
  });

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
    parsedValue: z.infer<typeof SpeechProviderIdSchema>,
    enabled: boolean
  ): RequestedSpeechProvider => ({
    provider: parsedValue,
    explicit: configuredValue !== undefined,
    enabled,
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
  const dictationEnabled =
    OptionalBooleanFlagSchema.parse(
      params.env.PASEO_DICTATION_ENABLED ?? params.persisted.features?.dictation?.enabled
    ) ?? true;
  const voiceModeEnabled =
    OptionalBooleanFlagSchema.parse(
      params.env.PASEO_VOICE_MODE_ENABLED ?? params.persisted.features?.voiceMode?.enabled
    ) ?? true;

  const parsed = RequestedSpeechProvidersSchema.parse({
    dictationStt: dictationSttProviderFromConfig ?? "local",
    voiceStt: voiceSttProviderFromConfig ?? "local",
    voiceTts: voiceTtsProviderFromConfig ?? "local",
  });

  return {
    dictationStt: resolveFeatureProvider(
      dictationSttProviderFromConfig,
      parsed.dictationStt,
      dictationEnabled
    ),
    voiceStt: resolveFeatureProvider(
      voiceSttProviderFromConfig,
      parsed.voiceStt,
      voiceModeEnabled
    ),
    voiceTts: resolveFeatureProvider(
      voiceTtsProviderFromConfig,
      parsed.voiceTts,
      voiceModeEnabled
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
    },
  };
}

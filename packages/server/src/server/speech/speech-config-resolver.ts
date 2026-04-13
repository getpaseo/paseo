import { z } from "zod";

import type { PersistedConfig } from "../persisted-config.js";
import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import { resolveLocalSpeechConfig } from "./providers/local/config.js";
import { resolveOpenAiSpeechConfig } from "./providers/openai/config.js";
import { resolveFunASRConfig, type FunASRConfig } from "./providers/funasr/config.js";
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
  voiceTurnDetection: OptionalSpeechProviderSchema.default("local"),
  voiceStt: OptionalSpeechProviderSchema.default("local"),
  voiceTts: OptionalSpeechProviderSchema.default("local"),
});

function resolveOptionalBooleanFlag(value: unknown): boolean {
  return OptionalBooleanFlagSchema.parse(value) ?? true;
}

function resolveRequestedSpeechProviders(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): RequestedSpeechProviders {
  const resolveFeatureProvider = (
    configuredValue: string | undefined,
    parsedValue: z.infer<typeof SpeechProviderIdSchema>,
    enabled: boolean,
  ): RequestedSpeechProvider => ({
    provider: parsedValue,
    explicit: configuredValue !== undefined,
    enabled,
  });

  const voiceModeEnabled = resolveOptionalBooleanFlag(
    params.env.PASEO_VOICE_MODE_ENABLED ?? params.persisted.features?.voiceMode?.enabled,
  );
  const featureProviders = {
    dictationStt: {
      configuredValue:
        params.env.PASEO_DICTATION_STT_PROVIDER ??
        params.persisted.features?.dictation?.stt?.provider,
      enabled: resolveOptionalBooleanFlag(
        params.env.PASEO_DICTATION_ENABLED ?? params.persisted.features?.dictation?.enabled,
      ),
    },
    voiceTurnDetection: {
      configuredValue:
        params.env.PASEO_VOICE_TURN_DETECTION_PROVIDER ??
        params.persisted.features?.voiceMode?.turnDetection?.provider,
      enabled: voiceModeEnabled,
    },
    voiceStt: {
      configuredValue:
        params.env.PASEO_VOICE_STT_PROVIDER ?? params.persisted.features?.voiceMode?.stt?.provider,
      enabled: voiceModeEnabled,
    },
    voiceTts: {
      configuredValue:
        params.env.PASEO_VOICE_TTS_PROVIDER ?? params.persisted.features?.voiceMode?.tts?.provider,
      enabled: voiceModeEnabled,
    },
  } satisfies Record<
    keyof RequestedSpeechProviders,
    {
      configuredValue: string | undefined;
      enabled: boolean;
    }
  >;

  const parsed = RequestedSpeechProvidersSchema.parse({
    dictationStt: featureProviders.dictationStt.configuredValue ?? "local",
    voiceTurnDetection: featureProviders.voiceTurnDetection.configuredValue ?? "local",
    voiceStt: featureProviders.voiceStt.configuredValue ?? "local",
    voiceTts: featureProviders.voiceTts.configuredValue ?? "local",
  });

  return {
    dictationStt: resolveFeatureProvider(
      featureProviders.dictationStt.configuredValue,
      parsed.dictationStt,
      featureProviders.dictationStt.enabled,
    ),
    voiceTurnDetection: resolveFeatureProvider(
      featureProviders.voiceTurnDetection.configuredValue,
      parsed.voiceTurnDetection,
      featureProviders.voiceTurnDetection.enabled,
    ),
    voiceStt: resolveFeatureProvider(
      featureProviders.voiceStt.configuredValue,
      parsed.voiceStt,
      featureProviders.voiceStt.enabled,
    ),
    voiceTts: resolveFeatureProvider(
      featureProviders.voiceTts.configuredValue,
      parsed.voiceTts,
      featureProviders.voiceTts.enabled,
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
  funasr: FunASRConfig | undefined;
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

  const needsFunASR =
    providers.dictationStt.provider === "local" ||
    providers.voiceStt.provider === "local";
  const funasr = needsFunASR
    ? resolveFunASRConfig({ env: params.env, persisted: params.persisted })
    : undefined;

  return {
    openai,
    speech: {
      providers,
      ...(local.local ? { local: local.local } : {}),
    },
    funasr,
  };
}

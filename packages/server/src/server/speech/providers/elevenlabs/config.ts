import type { PersistedConfig } from "../../../persisted-config.js";
import type { ElevenLabsTtsConfig } from "./tts.js";

export interface ElevenLabsSpeechProviderConfig {
  apiKey: string;
  baseUrl?: string;
  tts: ElevenLabsTtsConfig;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function resolveElevenLabsSpeechConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): ElevenLabsSpeechProviderConfig | undefined {
  const { env, persisted } = params;
  const providerConfig = persisted.providers?.elevenlabs as
    | { apiKey?: string; baseUrl?: string; voiceId?: string; modelId?: string }
    | undefined;

  const apiKey = firstDefined<string>([providerConfig?.apiKey, env.ELEVENLABS_API_KEY]);
  if (!apiKey) {
    return undefined;
  }

  const baseUrl = firstDefined<string>([providerConfig?.baseUrl, env.ELEVENLABS_BASE_URL]);
  const voiceId = firstDefined<string>([
    optionalTrimmedString(providerConfig?.voiceId),
    optionalTrimmedString(env.ELEVENLABS_VOICE_ID),
    optionalTrimmedString(env.ELEVENLABS_TTS_VOICE_ID),
  ]);
  if (!voiceId) {
    return undefined;
  }

  const modelId = firstDefined<string>([
    optionalTrimmedString(providerConfig?.modelId),
    optionalTrimmedString(env.ELEVENLABS_TTS_MODEL),
  ]);

  const tts: ElevenLabsTtsConfig = {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    voiceId,
    ...(modelId ? { modelId } : {}),
  };

  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    tts,
  };
}

import type { PersistedConfig } from "../../../persisted-config.js";
import type { ElevenLabsTtsConfig } from "./tts.js";

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
}): ElevenLabsTtsConfig | undefined {
  const { env, persisted } = params;
  const providerConfig = persisted.providers?.elevenlabs;

  const apiKey = firstDefined<string>([providerConfig?.apiKey, env.ELEVENLABS_API_KEY]);
  if (!apiKey) {
    return undefined;
  }

  const voiceId = firstDefined<string>([
    optionalTrimmedString(providerConfig?.voiceId),
    optionalTrimmedString(env.ELEVENLABS_VOICE_ID),
    optionalTrimmedString(env.ELEVENLABS_TTS_VOICE_ID),
  ]);
  if (!voiceId) {
    return undefined;
  }

  const baseUrl = firstDefined<string>([providerConfig?.baseUrl, env.ELEVENLABS_BASE_URL]);
  const modelId = firstDefined<string>([
    optionalTrimmedString(providerConfig?.modelId),
    optionalTrimmedString(env.ELEVENLABS_TTS_MODEL),
  ]);

  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    voiceId,
    ...(modelId ? { modelId } : {}),
  };
}

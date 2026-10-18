import type { SpeechSettings, SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";

import type { PersistedConfig } from "../persisted-config.js";
import {
  DICTATION_ENABLED_BY_DEFAULT,
  VOICE_MODE_ENABLED_BY_DEFAULT,
  resolveSpeechConfig,
} from "./speech-config-resolver.js";
import type { SpeechService } from "./speech-runtime.js";
import { LocalSttModelIdSchema, LocalTtsModelIdSchema } from "./providers/local/models.js";
import { SpeechProviderIdSchema, type SpeechProviderId } from "./speech-types.js";

// The `speech` section of the mutable daemon config is a view over three persisted
// blocks: features.dictation, features.voiceMode and providers.openai. This module owns
// both directions of that mapping.

type PersistedFeatures = NonNullable<PersistedConfig["features"]>;
type PersistedDictation = NonNullable<PersistedFeatures["dictation"]>;
type PersistedVoiceMode = NonNullable<PersistedFeatures["voiceMode"]>;
type PersistedStt = NonNullable<PersistedDictation["stt"]>;
type PersistedTts = NonNullable<PersistedVoiceMode["tts"]>;
type PersistedOpenAi = NonNullable<NonNullable<PersistedConfig["providers"]>["openai"]>;
type SttPatch = NonNullable<NonNullable<SpeechSettingsPatch["dictation"]>["stt"]>;
type TtsPatch = NonNullable<NonNullable<SpeechSettingsPatch["voiceMode"]>["tts"]>;

const DEFAULT_SPEECH_PROVIDER = "local";

// The daemon config store derives the speech view through this owner (the OpenAI key is
// write-only) and calls apply when the persisted speech blocks change.
export interface SpeechSettingsOwner {
  read(persisted: PersistedConfig): SpeechSettings;
  apply(persisted: PersistedConfig): void;
}

export function createSpeechSettingsOwner(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  speechService: Pick<SpeechService, "reconfigure">;
}): SpeechSettingsOwner {
  const { paseoHome, env, speechService } = params;
  return {
    read: (persisted) => readSpeechSettings(persisted, env),
    apply: (persisted) => {
      const resolved = resolveSpeechConfig({ paseoHome, env, persisted });
      speechService.reconfigure({ openaiConfig: resolved.openai, speechConfig: resolved.speech });
    },
  };
}

export function readSpeechSettings(
  persisted: PersistedConfig,
  env: NodeJS.ProcessEnv,
): SpeechSettings {
  const dictation = persisted.features?.dictation;
  const voiceMode = persisted.features?.voiceMode;
  return {
    dictation: {
      enabled: dictation?.enabled ?? DICTATION_ENABLED_BY_DEFAULT,
      stt: readStt(dictation?.stt),
    },
    voiceMode: {
      enabled: voiceMode?.enabled ?? VOICE_MODE_ENABLED_BY_DEFAULT,
      stt: readStt(voiceMode?.stt),
      tts: readTts(voiceMode?.tts),
    },
    openai: readOpenAi(persisted.providers?.openai, env),
  };
}

function readTts(tts: PersistedTts | undefined): SpeechSettings["voiceMode"]["tts"] {
  return {
    provider: tts?.provider ?? DEFAULT_SPEECH_PROVIDER,
    ...(tts?.model ? { model: tts.model } : {}),
    ...(tts?.voice ? { voice: tts.voice } : {}),
  };
}

function readOpenAi(
  openai: PersistedOpenAi | undefined,
  env: NodeJS.ProcessEnv,
): SpeechSettings["openai"] {
  const keys = [
    openai?.apiKey,
    openai?.stt?.apiKey,
    openai?.tts?.apiKey,
    env.OPENAI_API_KEY,
    env.OPENAI_STT_API_KEY,
    env.OPENAI_TTS_API_KEY,
  ];
  return {
    apiKeyConfigured: keys.some((key) => Boolean(key?.trim())),
    ...(openai?.baseUrl ? { baseUrl: openai.baseUrl } : {}),
  };
}

function readStt(stt: PersistedStt | undefined): SpeechSettings["dictation"]["stt"] {
  return {
    provider: stt?.provider ?? DEFAULT_SPEECH_PROVIDER,
    ...(stt?.model ? { model: stt.model } : {}),
    ...(stt?.language ? { language: stt.language } : {}),
  };
}

export function mergeSpeechSettingsPatch(
  persisted: PersistedConfig,
  patch: SpeechSettingsPatch,
): PersistedConfig {
  const features: PersistedFeatures = { ...persisted.features };
  if (patch.dictation) {
    const current = features.dictation;
    const stt = patch.dictation.stt ? mergeStt(current?.stt, patch.dictation.stt) : current?.stt;
    features.dictation = withoutUndefined({
      ...current,
      enabled: patch.dictation.enabled ?? current?.enabled,
      stt,
    });
  }
  if (patch.voiceMode) {
    const current = features.voiceMode;
    features.voiceMode = withoutUndefined({
      ...current,
      enabled: patch.voiceMode.enabled ?? current?.enabled,
      stt: patch.voiceMode.stt ? mergeStt(current?.stt, patch.voiceMode.stt) : current?.stt,
      tts: patch.voiceMode.tts ? mergeTts(current?.tts, patch.voiceMode.tts) : current?.tts,
    });
  }

  const providers = { ...persisted.providers };
  if (patch.openai) {
    providers.openai = mergeOpenAi(providers.openai, patch.openai);
  }

  return { ...persisted, features, providers };
}

function mergeStt(current: PersistedStt | undefined, patch: SttPatch): PersistedStt {
  const provider = parseProvider(patch.provider) ?? current?.provider;
  const providerChanged = patch.provider !== undefined && patch.provider !== current?.provider;
  const model = resolvePatchedValue(providerChanged ? undefined : current?.model, patch.model);
  assertLocalModelKind(provider, model, "stt");
  return withoutUndefined({
    ...current,
    provider,
    model,
    language: resolvePatchedValue(current?.language, patch.language),
  });
}

function mergeTts(current: PersistedTts | undefined, patch: TtsPatch): PersistedTts {
  const provider = parseProvider(patch.provider) ?? current?.provider;
  const providerChanged = patch.provider !== undefined && patch.provider !== current?.provider;
  const model = resolvePatchedValue(providerChanged ? undefined : current?.model, patch.model);
  assertLocalModelKind(provider, model, "tts");
  return withoutUndefined({
    ...current,
    provider,
    model,
    voice: resolvePatchedValue(providerChanged ? undefined : current?.voice, patch.voice),
  });
}

function mergeOpenAi(
  current: PersistedOpenAi | undefined,
  patch: NonNullable<SpeechSettingsPatch["openai"]>,
): PersistedOpenAi | undefined {
  const next = withoutUndefined({
    ...current,
    apiKey: resolvePatchedValue(current?.apiKey, trimToNull(patch.apiKey)),
    baseUrl: resolvePatchedValue(current?.baseUrl, trimToNull(patch.baseUrl)),
  });
  return Object.keys(next).length > 0 ? next : undefined;
}

// A local model id that is not in the catalog would stop the daemon from resolving its
// speech config at the next start, so reject it before it is written.
function assertLocalModelKind(
  provider: string | undefined,
  model: string | undefined,
  kind: "stt" | "tts",
): void {
  if ((provider ?? DEFAULT_SPEECH_PROVIDER) !== "local" || model === undefined) {
    return;
  }
  const schema = kind === "stt" ? LocalSttModelIdSchema : LocalTtsModelIdSchema;
  if (!schema.safeParse(model).success) {
    throw new Error(`Unknown local ${kind === "stt" ? "speech-to-text" : "voice"} model: ${model}`);
  }
}

function parseProvider(provider: string | undefined): SpeechProviderId | undefined {
  return provider === undefined ? undefined : SpeechProviderIdSchema.parse(provider);
}

// undefined keeps the current value; null clears it.
function resolvePatchedValue(
  current: string | undefined,
  patch: string | null | undefined,
): string | undefined {
  if (patch === undefined) return current;
  return patch ?? undefined;
}

function trimToNull(value: string | null | undefined): string | null | undefined {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

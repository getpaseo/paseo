import type { SpeechSettings, SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";

import {
  PersistedConfigSchema,
  SpeechSttConfigSchema,
  SpeechTtsConfigSchema,
  type PersistedConfig,
} from "../persisted-config.js";
import { resolveRequestedSpeechProviders, resolveSpeechConfig } from "./speech-config-resolver.js";
import type { SpeechService } from "./speech-runtime.js";
import { LocalSttModelIdSchema, LocalTtsModelIdSchema } from "./providers/local/models.js";

interface SpeechRead {
  features: SpeechSettings;
  envOverrides: Record<string, string>;
}

// Owns the per-site wire boundary: credential redaction, env provenance and patch
// semantics. The store never assembles or merges provider objects itself.
export interface SpeechSettingsOwner {
  read(persisted: PersistedConfig): SpeechRead;
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

export function readSpeechSettings(persisted: PersistedConfig, env: NodeJS.ProcessEnv): SpeechRead {
  const dictation = persisted.features?.dictation;
  const voiceMode = persisted.features?.voiceMode;
  const providers = resolveRequestedSpeechProviders({ persisted, env });
  const envOverrides: Record<string, string> = {};
  const recordOverride = (path: string, names: string[], fallback?: unknown) => {
    if (fallback !== undefined) return;
    const name = names.find((candidate) => env[candidate]?.trim());
    if (name) envOverrides[path] = name;
  };
  recordOverride("features.dictation.enabled", ["PASEO_DICTATION_ENABLED"]);
  recordOverride("features.voiceMode.enabled", ["PASEO_VOICE_MODE_ENABLED"]);
  recordOverride("features.voiceMode.turnDetection.provider", [
    "PASEO_VOICE_TURN_DETECTION_PROVIDER",
  ]);

  function readSite(
    site: Record<string, unknown> | undefined,
    provider: string,
    path: string,
    kind: "stt" | "tts",
    providerEnv: string,
    localModelEnv: string,
  ) {
    recordOverride(`${path}.provider`, [providerEnv]);
    const configured = site?.provider === provider ? site : undefined;
    const { apiKey, ...fields } = configured ?? {};
    const openaiModelEnv = kind === "stt" ? "STT_MODEL" : "TTS_MODEL";
    recordOverride(`${path}.model`, [provider === "openai" ? openaiModelEnv : localModelEnv]);
    if (kind === "stt") {
      const languageVars =
        path === "features.dictation.stt"
          ? ["PASEO_DICTATION_LANGUAGE"]
          : ["PASEO_VOICE_LANGUAGE", "PASEO_DICTATION_LANGUAGE"];
      recordOverride(`${path}.language`, languageVars);
    }
    if (provider === "openai") {
      for (const [field, suffix] of [
        ["apiKey", "API_KEY"],
        ["baseUrl", "BASE_URL"],
      ] as const) {
        recordOverride(
          `${path}.${field}`,
          [`OPENAI_${kind.toUpperCase()}_${suffix}`, `OPENAI_${suffix}`],
          configured?.[field],
        );
      }
      if (kind === "stt") {
        recordOverride(`${path}.confidenceThreshold`, ["STT_CONFIDENCE_THRESHOLD"]);
      } else recordOverride(`${path}.voice`, ["TTS_VOICE"]);
    } else if (kind === "tts") {
      recordOverride(`${path}.speakerId`, ["PASEO_VOICE_LOCAL_TTS_SPEAKER_ID"]);
      recordOverride(`${path}.speed`, ["PASEO_VOICE_LOCAL_TTS_SPEED"]);
    }
    return {
      ...fields,
      provider,
      ...(provider === "openai"
        ? { hasApiKey: typeof apiKey === "string" && apiKey.trim().length > 0 }
        : {}),
    };
  }

  return {
    features: {
      dictation: {
        enabled: providers.dictationStt.enabled !== false,
        stt: readSite(
          dictation?.stt,
          providers.dictationStt.provider,
          "features.dictation.stt",
          "stt",
          "PASEO_DICTATION_STT_PROVIDER",
          "PASEO_DICTATION_LOCAL_STT_MODEL",
        ),
      },
      voiceMode: {
        enabled: providers.voiceStt.enabled !== false,
        ...(voiceMode?.llm ? { llm: voiceMode.llm } : {}),
        ...(voiceMode?.turnDetection
          ? {
              turnDetection: {
                ...voiceMode.turnDetection,
                provider: providers.voiceTurnDetection.provider,
              },
            }
          : {}),
        stt: readSite(
          voiceMode?.stt,
          providers.voiceStt.provider,
          "features.voiceMode.stt",
          "stt",
          "PASEO_VOICE_STT_PROVIDER",
          "PASEO_VOICE_LOCAL_STT_MODEL",
        ),
        tts: readSite(
          voiceMode?.tts,
          providers.voiceTts.provider,
          "features.voiceMode.tts",
          "tts",
          "PASEO_VOICE_TTS_PROVIDER",
          "PASEO_VOICE_LOCAL_TTS_MODEL",
        ),
      },
    },
    envOverrides,
  };
}

function mergeFields(current: Record<string, unknown> | undefined, patch: Record<string, unknown>) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || (typeof value === "string" && !value.trim())) delete next[key];
    else next[key] = typeof value === "string" ? value.trim() : value;
  }
  return next;
}

function mergeSite(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
  kind: "stt" | "tts",
) {
  const providerChanged =
    patch.provider !== undefined && patch.provider !== (current?.provider ?? "local");
  const next = mergeFields(providerChanged ? undefined : current, patch);
  next.provider ??= "local";
  const site = (kind === "stt" ? SpeechSttConfigSchema : SpeechTtsConfigSchema).parse(next);
  if (site.provider === "local" && site.model !== undefined) {
    const schema = kind === "stt" ? LocalSttModelIdSchema : LocalTtsModelIdSchema;
    if (!schema.safeParse(site.model).success) {
      throw new Error(
        `Unknown local ${kind === "stt" ? "speech-to-text" : "voice"} model: ${site.model}`,
      );
    }
  }
  return site;
}

export function mergeSpeechSettingsPatch(
  persisted: PersistedConfig,
  patch: SpeechSettingsPatch,
): PersistedConfig {
  const features = { ...persisted.features };
  if (patch.dictation) {
    const { stt, ...rest } = patch.dictation;
    const next = mergeFields(features.dictation, rest);
    if (stt) next.stt = mergeSite(features.dictation?.stt, stt, "stt");
    features.dictation = PersistedConfigSchema.shape.features.unwrap().shape.dictation.parse(next);
  }
  if (patch.voiceMode) {
    const { stt, tts, llm, turnDetection, ...rest } = patch.voiceMode;
    const next = mergeFields(features.voiceMode, rest);
    if (stt) next.stt = mergeSite(features.voiceMode?.stt, stt, "stt");
    if (tts) next.tts = mergeSite(features.voiceMode?.tts, tts, "tts");
    if (llm) next.llm = mergeFields(features.voiceMode?.llm, llm);
    if (turnDetection)
      next.turnDetection = mergeFields(features.voiceMode?.turnDetection, turnDetection);
    features.voiceMode = PersistedConfigSchema.shape.features.unwrap().shape.voiceMode.parse(next);
  }
  return { ...persisted, features };
}
